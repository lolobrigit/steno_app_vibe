// Системный трей / строка меню (macOS).
// ЛКМ по иконке — быстрый старт записи, ПКМ — контекстное меню.

const { Tray, Menu, nativeImage } = require('electron')

/**
 * @param {object} cb
 * @param {string} cb.trayIconPath
 * @param {(bounds: Electron.Rectangle) => void} cb.onQuickStart  левая кнопка
 * @param {() => void} cb.onOpen
 * @param {(target: string) => void} cb.onNavigate               навигация в веб-приложении
 * @param {() => void} cb.onUnloadModels
 * @param {() => void} cb.onQuit
 */
function createTray(cb) {
  const image = nativeImage.createFromPath(cb.trayIconPath).resize({ width: 22, height: 22 })
  if (process.platform === 'darwin') image.setTemplateImage(true)

  const tray = new Tray(image)
  tray.setToolTip('STENO — расшифровка речи')

  const menu = Menu.buildFromTemplate([
    { label: '⚡ Быстрая запись', click: () => cb.onQuickStart(null) },
    { label: 'Открыть STENO', click: () => cb.onOpen() },
    { type: 'separator' },
    { label: 'Новая расшифровка', click: () => cb.onNavigate('new') },
    { label: 'Настройки и модели', click: () => cb.onNavigate('settings') },
    { label: 'Хранилище / загрузки', click: () => cb.onNavigate('storage') },
    { label: 'История / проекты', click: () => cb.onNavigate('projects') },
    { type: 'separator' },
    {
      label: 'Выгрузить модели из памяти',
      sublabel: 'Освободить GPU/CPU до следующего запуска распознавания',
      click: () => cb.onUnloadModels(),
    },
    { type: 'separator' },
    { label: 'Выход', click: () => cb.onQuit() },
  ])

  // Windows/Linux: ПКМ — меню; ЛКМ — быстрый старт.
  tray.on('right-click', () => tray.popUpContextMenu(menu))
  tray.on('click', (_e, bounds) => cb.onQuickStart(bounds))
  // macOS: клик по иконке в menu bar — быстрый старт, right-click — меню
  tray.on('right-click', () => tray.popUpContextMenu(menu))

  return tray
}

module.exports = { createTray }
