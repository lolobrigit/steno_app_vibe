// Подписи главного процесса и трея. Язык: настройка `language`
// ('ru' | 'en'); по умолчанию — локаль ОС.

const DICT = {
  ru: {
    quickRecord: '⚡ Быстрая запись',
    open: 'Открыть STENO',
    newTranscription: 'Новая расшифровка',
    settingsModels: 'Настройки и модели',
    storage: 'Хранилище / загрузки',
    projects: 'История / проекты',
    unload: 'Выгрузить модели из памяти',
    unloadSub: 'Освободить GPU/CPU до следующего запуска распознавания',
    language: 'Язык / Language',
    quit: 'Выход',
    tooltip: 'STENO — расшифровка речи',
    tooltipRec: 'STENO — идёт запись…',
    quickTitle: 'STENO — быстрая запись',
    pickerTitle: 'STENO — выбор источника',
    modelsDirDialog: 'Папка для моделей',
    recordingsDirDialog: 'Папка для записей',
  },
  en: {
    quickRecord: '⚡ Quick record',
    open: 'Open STENO',
    newTranscription: 'New transcription',
    settingsModels: 'Settings and models',
    storage: 'Storage / downloads',
    projects: 'History / projects',
    unload: 'Unload models from memory',
    unloadSub: 'Free GPU/CPU until the next transcription run',
    language: 'Language / Язык',
    quit: 'Quit',
    tooltip: 'STENO — speech transcription',
    tooltipRec: 'STENO — recording…',
    quickTitle: 'STENO — quick record',
    pickerTitle: 'STENO — source picker',
    modelsDirDialog: 'Models folder',
    recordingsDirDialog: 'Recordings folder',
  },
}

function detectLanguage(app, settings) {
  const explicit = settings.get('language')
  if (explicit === 'ru' || explicit === 'en') return explicit
  return app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

function tr(app, settings) {
  const lang = detectLanguage(app, settings)
  return { lang, s: DICT[lang] }
}

module.exports = { DICT, detectLanguage, tr }
