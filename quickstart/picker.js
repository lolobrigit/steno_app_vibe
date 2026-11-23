// Окно-выборщик источника для записи экрана из главного окна:
// веб-приложение вызвало getDisplayMedia без заранее выбранного источника —
// пользователь выбирает экран/окно здесь, выбор уходит в главный процесс.

const $ = (sel) => document.querySelector(sel)
const native = window.stenoNative

const T = {
  ru: {
    title: 'Выберите, что записывать',
    hint: 'Экран или окно — для записи из основного окна',
    screens: 'Экраны',
    windows: 'Окна',
    audio: 'со звуком системы',
    cancel: 'Отмена',
    empty: 'Источники не найдены',
  },
  en: {
    title: 'Choose what to record',
    hint: 'Screen or window — recording from the main window',
    screens: 'Screens',
    windows: 'Windows',
    audio: 'with system audio',
    cancel: 'Cancel',
    empty: 'No sources found',
  },
}

let lang = 'ru'
let sources = []
let tab = 'screen'

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function render() {
  const t = T[lang]
  $('#title').textContent = t.title
  $('#hint').textContent = t.hint
  $('#tab-screens').textContent = t.screens
  $('#tab-windows').textContent = t.windows
  $('#sys-audio-label').textContent = t.audio
  $('#cancel').textContent = t.cancel
  $('#tab-screens').classList.toggle('active', tab === 'screen')
  $('#tab-windows').classList.toggle('active', tab === 'window')

  const list = sources.filter((s) => s.kind === tab)
  const wrap = $('#source-list')
  wrap.innerHTML = ''
  for (const s of list) {
    const el = document.createElement('button')
    el.className = 'source'
    el.innerHTML = `<img src="${s.thumbnail}" alt=""/><span>${escapeHtml(s.name)}</span>`
    el.addEventListener('click', () => choose(s.id))
    wrap.appendChild(el)
  }
  if (list.length === 0) wrap.innerHTML = `<p class="muted">${t.empty}</p>`
}

function choose(sourceId) {
  native.pickerChoice(sourceId, $('#with-audio').checked)
}

$('#tab-screens').addEventListener('click', () => {
  tab = 'screen'
  render()
})
$('#tab-windows').addEventListener('click', () => {
  tab = 'window'
  render()
})
$('#cancel').addEventListener('click', () => native.pickerChoice(null, false))

void (async () => {
  try {
    const state = await native.getState()
    if (state.language === 'en') lang = 'en'
  } catch {
    /* ignore */
  }
  try {
    sources = await native.listSources()
  } catch {
    sources = []
  }
  render()
})()
