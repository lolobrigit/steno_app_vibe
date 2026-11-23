// Хранение настроек десктоп-приложения: JSON в userData.
// Без зависимостей — атомарная запись через временный файл.

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  /** куда грузить интерфейс: 'local' — собранный web/dist, 'remote' — URL */
  appMode: 'remote',
  /** адрес развёрнутой веб-версии (как у вас: https://vlcast.com/whisper) */
  appUrl: 'https://vlcast.com/whisper',
  /** папка с моделями Hugging Face (структура owner/model/resolve/rev/file) */
  modelsDir: null,
  /** куда сохранять записи из быстрого старта */
  recordingsDir: null,
  /** сворачивать в трей при закрытии окна */
  minimizeToTray: true,
  /** запускать вместе с системой */
  autoLaunch: false,
  /** стартовать свёрнутым в трей */
  startMinimized: false,
}

class Settings {
  constructor(app) {
    this.file = path.join(app.getPath('userData'), 'steno-desktop.json')
    this.data = { ...DEFAULTS }
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      Object.assign(this.data, JSON.parse(raw))
    } catch {
      /* первый запуск — дефолты */
    }
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    this.data[key] = value
    this.persist()
  }

  all() {
    return { ...this.data }
  }

  persist() {
    try {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.error('settings persist failed', e)
    }
  }
}

module.exports = { Settings, DEFAULTS }
