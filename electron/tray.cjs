// Системный трей / строка меню (macOS).
// ЛКМ — быстрый старт записи, ПКМ — меню, двойной клик — главное окно.
// Во время записи иконка моргает красной точкой (icon-rec.png ↔ icon.png).

const { Tray, Menu, nativeImage } = require('electron')

/**
 * @param {object} cb
 * @param {string} cb.trayIconPath        обычная иконка
 * @param {string} cb.trayIconRecPath     иконка с красной точкой (запись)
 * @param {object} cb.labels              подписи из electron/i18n.cjs
 * @param {string} cb.lang                'ru' | 'en'
 * @param {(bounds: Electron.Rectangle) => void} cb.onQuickStart
 * @param {() => void} cb.onOpen
 * @param {(target: string) => void} cb.onNavigate
 * @param {() => void} cb.onUnloadModels
 * @param {(lang: string) => void} cb.onLanguage
 * @param {() => void} cb.onQuit
 */
function createTray(cb) {
  const base = nativeImage.createFromPath(cb.trayIconPath).resize({ width: 22, height: 22 })
  const rec = nativeImage.createFromPath(cb.trayIconRecPath).resize({ width: 22, height: 22 })
  if (process.platform === 'darwin') base.setTemplateImage(true)
  // красную точку на macOS не делаем template — иначе точка не красная

  const tray = new Tray(base)
  const L = cb.labels
  tray.setToolTip(L.tooltip)

  const menu = Menu.buildFromTemplate([
    { label: L.quickRecord, click: () => cb.onQuickStart(null) },
    { label: L.open, click: () => cb.onOpen() },
    { type: 'separator' },
    { label: L.newTranscription, click: () => cb.onNavigate('new') },
    { label: L.settingsModels, click: () => cb.onNavigate('settings') },
    { label: L.storage, click: () => cb.onNavigate('storage') },
    { label: L.projects, click: () => cb.onNavigate('projects') },
    { type: 'separator' },
    {
      label: L.language,
      submenu: [
        {
          label: 'Русский',
          type: 'radio',
          checked: cb.lang === 'ru',
          click: () => cb.onLanguage('ru'),
        },
        {
          label: 'English',
          type: 'radio',
          checked: cb.lang === 'en',
          click: () => cb.onLanguage('en'),
        },
      ],
    },
    { type: 'separator' },
    { label: L.unload, sublabel: L.unloadSub, click: () => cb.onUnloadModels() },
    { type: 'separator' },
    { label: L.quit, click: () => cb.onQuit() },
  ])

  tray.on('right-click', () => tray.popUpContextMenu(menu))
  tray.on('click', (_e, bounds) => cb.onQuickStart(bounds))
  tray.on('double-click', () => cb.onOpen())

  // ─── индикация записи: плавное моргание красной точкой ────────────────────
  let blinkTimer = null
  let recOn = false
  function setRecording(on) {
    recOn = on
    if (blinkTimer) {
      clearInterval(blinkTimer)
      blinkTimer = null
    }
    if (on) {
      let phase = false
      tray.setToolTip(L.tooltipRec)
      blinkTimer = setInterval(() => {
        phase = !phase
        tray.setImage(phase ? rec : base)
      }, 700)
    } else {
      tray.setImage(base)
      tray.setToolTip(L.tooltip)
    }
  }

  return { tray, setRecording, isRecording: () => recOn }
}

module.exports = { createTray }
