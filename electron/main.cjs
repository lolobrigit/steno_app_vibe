// Точка входа главного процесса STENO Desktop.
//
// Покрывает требования к нативному приложению:
//  1. Веб-версия внутри: локальная сборка (web/dist через встроенный сервер)
//     или удалённый URL (по умолчанию https://vlcast.com/whisper).
//  2. Сворачивание в трей / панель (minimizeToTray).
//  3. Захват звука/видео: микрофон, системный звук (WASAPI loopback на
//     Windows), экран/окно/камера — см. setDisplayMediaRequestHandler и
//     quickstart-окно.
//  4/5. Трей: левая кнопка — быстрый старт записи, правая — меню (tray.cjs).
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

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

let settings
let downloads
let mainWindow = null
let quickWindow = null
let localServer = null
let quitting = false

/** Ожидающий запрос захвата: какой источник отдать в getDisplayMedia. */
let pendingCapture = null // {sourceId?: string, audio: boolean}

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
// Это и есть «модели можно загрузить предварительно по прямым ссылкам»:
// качалка models.cjs складывает файлы ровно по этим путям.
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
// Веб-приложение вызывает getDisplayMedia (запись экрана) — здесь выбираем
// источник. Если quickstart заранее указал источник (pendingCapture), берём
// его; иначе — первый экран. Системный звук: 'loopback' работает на Windows
// (WASAPI loopback); на macOS нужен виртуальный драйвер (BlackHole), на Linux
// зависит от PipeWire/PulseAudio.
function installDisplayMediaHandler() {
  const { desktopCapturer } = require('electron')
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    const want = pendingCapture
    pendingCapture = null
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        let source = null
        if (want?.sourceId) source = sources.find((s) => s.id === want.sourceId) || null
        if (!source) source = sources.find((s) => s.id.startsWith('screen')) || sources[0]
        if (!source) return callback({})
        const withAudio = want ? want.audio : true
        if (withAudio && isWin) {
          callback({ video: source, audio: 'loopback' })
        } else {
          // macOS: системный звук без драйвера недоступен — только видео
          callback({ video: source })
        }
      })
      .catch(() => callback({}))
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
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
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

/** Быстрый старт: компактное окно записи рядом с треем. */
function toggleQuickWindow(anchorBounds) {
  if (quickWindow) {
    quickWindow.close()
    quickWindow = null
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
    title: 'STENO — быстрая запись',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: webPreferences(),
  })
  quickWindow.loadFile(path.join(__dirname, '..', 'quickstart', 'index.html'))
  quickWindow.on('blur', () => {
    // клик мимо — закрыть (как системное меню)
    if (quickWindow && !quickWindow.webContents.isDevToolsOpened()) {
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
  }))

  ipcMain.handle('steno:set', (_e, key, value) => {
    settings.set(key, value)
    if (key === 'autoLaunch') {
      app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: true })
    }
    return settings.all()
  })

  ipcMain.handle('steno:choose-dir', async (_e, which) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: which === 'modelsDir' ? 'Папка для моделей' : 'Папка для записей',
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

  // источники захвата для quickstart
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

  createTray({
    trayIconPath: path.join(__dirname, '..', 'build', 'icon.png'),
    onQuickStart: (bounds) => toggleQuickWindow(bounds),
    onOpen: () => showMainWindow(),
    onNavigate: (target) => navigate(target),
    onUnloadModels: () => {
      if (mainWindow) mainWindow.webContents.send('steno:unload-models')
    },
    onQuit: () => {
      quitting = true
      app.quit()
    },
  })

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
