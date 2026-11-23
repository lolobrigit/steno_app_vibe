// Preload: мост между веб-приложением / quickstart-окном и главным процессом.
// Открывает window.stenoNative — единственный канал в систему.

const { contextBridge, ipcRenderer } = require('electron')

// aria-label навигации в веб-приложении (en/ru пары из steno_vibe)
const NAV_LABELS = {
  new: ['New transcription', 'Новая расшифровка'],
  settings: ['Settings and models', 'Настройки и модели'],
  storage: ['Storage', 'Хранилище'],
  projects: ['Projects: export / import', 'Проекты: экспорт / импорт'],
  guide: ['Which model to choose', 'Какую модель выбрать'],
}

function navigateInPage(target) {
  const labels = NAV_LABELS[target] || []
  for (const label of labels) {
    const el = document.querySelector(`[aria-label="${label}"]`)
    if (el) {
      el.click()
      return true
    }
  }
  return false
}

/** Передать файл в веб-приложение так, будто его выбрали в диалоге. */
async function injectFileIntoPage(filePath) {
  const res = await ipcRenderer.invoke('steno:read-file', filePath)
  if (!res) return false
  const name = filePath.split(/[\\/]/).pop()
  const file = new File([res], name, { type: guessMime(name) })
  const dt = new DataTransfer()
  dt.items.add(file)
  // скрытый input[type=file] в панели источника веб-приложения
  const input = document.querySelector('input[type="file"]')
  if (!input) return false
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase()
  return (
    {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      flac: 'audio/flac',
      webm: 'video/webm',
      mp4: 'video/mp4',
      mkv: 'video/x-matroska',
      mov: 'video/quicktime',
    }[ext] || 'application/octet-stream'
  )
}

// навигация из трея
ipcRenderer.on('steno:navigate', (_e, target) => {
  // страница может быть ещё не готова — несколько попыток
  let tries = 0
  const timer = setInterval(() => {
    if (navigateInPage(target) || ++tries > 20) clearInterval(timer)
  }, 300)
})

// файл для расшифровки из quickstart / проводника
ipcRenderer.on('steno:file', (_e, filePath) => {
  let tries = 0
  const timer = setInterval(() => {
    void injectFileIntoPage(filePath).then((ok) => {
      if (ok || ++tries > 20) clearInterval(timer)
    })
  }, 300)
})

// трей: «выгрузить модели из памяти» — событие для веб-приложения.
// Веб-приложение подгружает модели лениво (только когда нужны); этим
// событием оно может сбросить уже загруженные веса из GPU/CPU.
ipcRenderer.on('steno:unload-models', () => {
  window.dispatchEvent(new CustomEvent('steno:unload-models'))
  // запасной вариант для сборок, где есть явный хук
  if (typeof window.__stenoUnload === 'function') window.__stenoUnload()
})

contextBridge.exposeInMainWorld('stenoNative', {
  isNative: true,
  platform: process.platform,

  // состояние и настройки
  getState: () => ipcRenderer.invoke('steno:get-state'),
  set: (key, value) => ipcRenderer.invoke('steno:set', key, value),
  chooseDir: (which) => ipcRenderer.invoke('steno:choose-dir', which),

  // модели: загрузка по прямым ссылкам в выбранную папку
  downloads: {
    add: (url) => ipcRenderer.invoke('steno:download-add', url),
    cancel: (id) => ipcRenderer.invoke('steno:download-cancel', id),
    resume: (id) => ipcRenderer.invoke('steno:download-resume', id),
    clearDone: () => ipcRenderer.invoke('steno:download-clear-done'),
    onUpdate: (cb) => {
      const listener = (_e, state) => cb(state)
      ipcRenderer.on('steno:downloads', listener)
      return () => ipcRenderer.removeListener('steno:downloads', listener)
    },
  },

  // захват: источники экрана/окон и заказ источника для getDisplayMedia
  listSources: () => ipcRenderer.invoke('steno:list-sources'),
  requestCapture: (sourceId, audio) =>
    ipcRenderer.invoke('steno:request-capture', sourceId, audio),

  // записи quickstart
  saveRecording: (name, buffer) => ipcRenderer.invoke('steno:save-recording', name, buffer),
  injectFile: (filePath) => ipcRenderer.invoke('steno:inject-file', filePath),
  openPath: (p) => ipcRenderer.invoke('steno:open-path', p),
})
