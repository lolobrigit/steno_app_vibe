// Точка входа главного процесса STENO Desktop.
//
//  1. Веб-версия внутри: локальная сборка (web/dist через встроенный сервер)
//     или удалённый URL (по умолчанию https://vlcast.com/whisper).
//  2. Сворачивание в трей / панель (minimizeToTray).
//  3. Захват звука/видео: микрофон, системный звук (WASAPI loopback на
//     Windows), экран/окно/камера. Из главного окна источник выбирается
//     в окне-выборщике (picker), из quickstart — заранее (pendingCapture).
//  4/5. Трей: левая кнопка — быстрый старт, двойной клик — главное окно,
//     правая — меню; во время записи иконка моргает красной точкой.
//  6. Модели по прямым ссылкам в выбранную папку (models.cjs) + подстановка
//     локальных файлов вместо сети (installModelInterceptor).
//  7. Ленивая загрузка моделей в GPU/CPU — со стороны веб-приложения;
//     из трея можно отправить событие выгрузки (steno:unload-models).

const { app, BrowserWindow, ipcMain, dialog, session, net, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { Settings } = require('./settings.cjs')
const { Downloads, urlToRelPath } = require('./models.cjs')
const { createTray } = require('./tray.cjs')
const { startStaticServer } = require('./server.cjs')
const { tr } = require('./i18n.cjs')

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let settings
let downloads
let trayApi = null
let mainWindow = null
let quickWindow = null
let pickerWindow = null
let pickerResolve = null
let localServer = null
let quitting = false
/** идёт запись (quickstart сообщает через steno:rec-state) */
let recActive = false

/** Ожидающий запрос захвата: какой источник отдать в getDisplayMedia. */
let pendingCapture = null // {sourceId?: string, audio: boolean}

const iconPath = (name) => path.join(__dirname, '..', 'build', name)
const L = () => tr(app, settings).s

// ─── одна копия приложения ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

// ─── перехват загрузок моделей HF → локальная папка ───────────────────────────
// Если файл уже лежит в modelsDir по «родному» пути репозитория
// (owner/model/resolve/rev/file), отдаём его вместо скачивания из сети.
function installModelInterceptor() {
  const ses = session.defaultSession
  ses.protocol.handle('https', async (req) => {
    const url = req.url
    const isModel =
      /^https:\/\/(huggingface\.co|hf-mirror\.com)\/[\w.-]+\/[\w.-]+\/resolve\//.test(url)
    if (isModel && downloads) {
      try {
        const rel = urlToRelPath(url)
        const file = path.join(downloads.modelsRoot(), rel)
        if (fs.existsSync(file)) {
          if (req.method === 'HEAD' || req.method === 'OPTIONS') {
            return new Response(null, {
              status: 200,
              headers: corsHeaders({ 'content-length': String(fs.statSync(file).size) }),
            })
          }
          const res = await net.fetch(pathToFileURL(file).toString())
          return new Response(res.body, {
            status: 200,
            headers: corsHeaders({
              'content-length': String(fs.statSync(file).size),
              'content-type': 'application/octet-stream',
            }),
          })
        }
      } catch (e) {
        console.warn('model intercept failed, falling back to network', e)
      }
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders({}) })
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true })
  })
}

function corsHeaders(extra) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
    ...extra,
  }
}

// ─── захват экрана/окна/звука для getDisplayMedia ────────────────────────────
// Порядок выбора источника:
//  - quickstart заранее указал источник (pendingCapture) — берём его;
//  - иначе (главное окно, кнопка «запись экрана» в веб-приложении) —
//    показываем окно-выборщик источника и ждём выбора пользователя.
// Системный звук: 'loopback' работает на Windows (WASAPI loopback);
// на macOS нужен виртуальный драйвер (BlackHole), на Linux — PipeWire/PulseAudio.
function installDisplayMediaHandler() {
  const { desktopCapturer } = require('electron')
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    const want = pendingCapture
    pendingCapture = null

    const serve = (sourceId, withAudio) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          let source = null
          if (sourceId) source = sources.find((s) => s.id === sourceId) || null
          if (!source) source = sources.find((s) => s.id.startsWith('screen')) || sources[0]
          if (!source) return callback({})
          if (withAudio && isWin) callback({ video: source, audio: 'loopback' })
          else callback({ video: source })
        })
        .catch(() => callback({}))
    }

    if (want) {
      serve(want.sourceId, want.audio)
      return
    }
    // источник не выбран заранее — спрашиваем пользователя
    openSourcePicker()
      .then((choice) => {
        if (!choice) return callback({})
        serve(choice.sourceId, choice.audio)
      })
      .catch(() => callback({}))
  })
}

/** Окно-выборщик источника для записи экрана из главного окна. */
function openSourcePicker() {
  return new Promise((resolve) => {
    if (pickerResolve) pickerResolve(null) // старый запрос отменяем
    pickerResolve = resolve
    pickerWindow = new BrowserWindow({
      width: 560,
      height: 520,
      resizable: true,
      minimizable: false,
      autoHideMenuBar: true,
      title: L().pickerTitle,
      icon: iconPath('icon.png'),
      webPreferences: webPreferences(),
    })
    pickerWindow.loadFile(path.join(__dirname, '..', 'quickstart', 'picker.html'))
    pickerWindow.on('closed', () => {
      pickerWindow = null
      if (pickerResolve) {
        pickerResolve(null)
        pickerResolve = null
      }
    })
  })
}

// ─── окна ─────────────────────────────────────────────────────────────────────
function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false, // нужен доступ к fs через IPC-обёртки
    backgroundThrottling: false, // запись/расшифровка не должны засыпать
  }
}

async function mainWindowUrl() {
  if (settings.get('appMode') === 'local') {
    const distDir = path.join(__dirname, '..', 'web', 'dist')
    if (fs.existsSync(path.join(distDir, 'index.html'))) {
      if (!localServer) localServer = await startStaticServer(distDir, settings)
      return localServer.url
    }
    console.warn('local web/dist not found, falling back to remote URL')
  }
  return settings.get('appUrl')
}

async function createMainWindow(startHidden) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: !startHidden,
    autoHideMenuBar: true,
    icon: iconPath('icon.png'),
    webPreferences: webPreferences(),
  })

  mainWindow.loadURL(await mainWindowUrl())

  // внешние ссылки — в системный браузер
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // сворачивание в трей вместо выхода
  mainWindow.on('close', (e) => {
    if (!quitting && settings.get('minimizeToTray')) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function showMainWindow() {
  if (!mainWindow) {
    void createMainWindow(false)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Быстрый старт: компактное окно записи рядом с треем.
 * Если окно уже есть — показываем его (идущая запись не теряется,
 * состояние живёт в рендерере). Потеря фокуса: во время записи окно
 * прячется в трей (иконка моргает), в простое — закрывается.
 */
function toggleQuickWindow(anchorBounds) {
  if (quickWindow) {
    if (quickWindow.isVisible()) quickWindow.focus()
    else quickWindow.show()
    return
  }
  const width = 420
  const height = 560
  let x
  let y
  if (anchorBounds) {
    x = Math.round(anchorBounds.x + anchorBounds.width / 2 - width / 2)
    y = isMac
      ? Math.round(anchorBounds.y + anchorBounds.height + 4)
      : Math.round(anchorBounds.y - height - 4)
  }
  quickWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: L().quickTitle,
    icon: iconPath('icon.png'),
    webPreferences: webPreferences(),
  })
  quickWindow.loadFile(path.join(__dirname, '..', 'quickstart', 'index.html'))
  quickWindow.on('blur', () => {
    if (!quickWindow || quickWindow.webContents.isDevToolsOpened()) return
    if (recActive) {
      // идёт запись — не закрываем, прячем; в трее моргает индикатор
      quickWindow.hide()
    } else {
      quickWindow.close()
    }
  })
  quickWindow.on('closed', () => {
    quickWindow = null
  })
}

/** Навигация внутри веб-приложения из трея. */
function navigate(target) {
  showMainWindow()
  const send = () => mainWindow?.webContents.send('steno:navigate', target)
  if (mainWindow?.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

/** Пересоздать трей (смена языка меню). */
function rebuildTray() {
  const { lang, s } = tr(app, settings)
  const wasRecording = trayApi?.isRecording() || false
  if (trayApi) trayApi.tray.destroy()
  trayApi = createTray({
    trayIconPath: iconPath('icon.png'),
    trayIconRecPath: iconPath('icon-rec.png'),
    labels: s,
    lang,
    onQuickStart: (bounds) => toggleQuickWindow(bounds),
    onOpen: () => showMainWindow(),
    onNavigate: (target) => navigate(target),
    onUnloadModels: () => {
      if (mainWindow) mainWindow.webContents.send('steno:unload-models')
    },
    onLanguage: (lang2) => {
      settings.set('language', lang2)
      rebuildTray()
    },
    onQuit: () => {
      quitting = true
      app.quit()
    },
  })
  if (wasRecording) trayApi.setRecording(true)
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
function recordingsRoot() {
  return settings.get('recordingsDir') || path.join(app.getPath('videos') || app.getPath('userData'), 'STENO')
}

function installIpc() {
  ipcMain.handle('steno:get-state', () => ({
    settings: settings.all(),
    downloads: downloads.list(),
    platform: process.platform,
    version: app.getVersion(),
    recordingsDir: recordingsRoot(),
    language: tr(app, settings).lang,
  }))

  ipcMain.handle('steno:set', (_e, key, value) => {
    settings.set(key, value)
    if (key === 'autoLaunch') {
      app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: true })
    }
    if (key === 'language') rebuildTray()
    return settings.all()
  })

  ipcMain.handle('steno:choose-dir', async (_e, which) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: which === 'modelsDir' ? L().modelsDirDialog : L().recordingsDirDialog,
    })
    if (r.canceled || !r.filePaths[0]) return null
    settings.set(which, r.filePaths[0])
    return r.filePaths[0]
  })

  // загрузка моделей по прямым ссылкам
  ipcMain.handle('steno:download-add', (_e, url) => downloads.add(String(url)))
  ipcMain.handle('steno:download-cancel', (_e, id) => downloads.cancel(String(id)))
  ipcMain.handle('steno:download-resume', (_e, id) => downloads.resume(String(id)))
  ipcMain.handle('steno:download-clear-done', () => downloads.removeDone())

  // источники захвата для quickstart и picker
  ipcMain.handle('steno:list-sources', async () => {
    const { desktopCapturer } = require('electron')
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon?.toDataURL() || null,
    }))
  })

  // quickstart выбрал источник → следующий getDisplayMedia получит его
  ipcMain.handle('steno:request-capture', (_e, sourceId, audio) => {
    pendingCapture = { sourceId: sourceId || null, audio: Boolean(audio) }
  })

  // выбор в окне-выборщике (запись экрана из главного окна)
  ipcMain.on('steno:picker-choice', (_e, sourceId, audio) => {
    const resolve = pickerResolve
    pickerResolve = null
    if (pickerWindow) pickerWindow.close()
    pickerWindow = null
    if (resolve) resolve(sourceId ? { sourceId: String(sourceId), audio: Boolean(audio) } : null)
  })

  // индикация записи в трее (quickstart сообщает старт/стоп)
  ipcMain.on('steno:rec-state', (_e, on) => {
    recActive = Boolean(on)
    trayApi?.setRecording(recActive)
  })

  // сохранение записи из quickstart в папку записей
  ipcMain.handle('steno:save-recording', (_e, name, buffer) => {
    const dir = recordingsRoot()
    fs.mkdirSync(dir, { recursive: true })
    const safe = String(name).replace(/[^\wа-яё .-]/gi, '_')
    const file = path.join(dir, safe)
    fs.writeFileSync(file, Buffer.from(buffer))
    return file
  })

  // отправить записанный файл в веб-приложение на расшифровку
  ipcMain.handle('steno:inject-file', (_e, filePath) => {
    showMainWindow()
    const send = () => mainWindow?.webContents.send('steno:file', filePath)
    if (mainWindow?.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', send)
    } else {
      send()
    }
  })

  // чтение файла для передачи в веб-приложение (инъекция в input[type=file])
  ipcMain.handle('steno:read-file', (_e, p) => {
    try {
      return fs.readFileSync(String(p))
    } catch {
      return null
    }
  })

  ipcMain.handle('steno:open-path', (_e, p) => shell.openPath(String(p)))
  ipcMain.handle('steno:show-quick', () => toggleQuickWindow(null))
}

// ─── жизненный цикл ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  settings = new Settings(app)
  downloads = new Downloads(app, settings, (state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('steno:downloads', state)
    }
  })

  installModelInterceptor()
  installDisplayMediaHandler()
  installIpc()
  rebuildTray()

  if (settings.get('autoLaunch')) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
  }

  await createMainWindow(Boolean(settings.get('startMinimized')))

  app.on('activate', () => {
    // macOS: клик по доку — показать окно
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow(false)
    else showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // живём в трее; выход — только через меню «Выход»
  if (isMac && quitting) app.quit()
})

app.on('before-quit', () => {
  quitting = true
})
