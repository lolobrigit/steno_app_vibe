// Логика окна быстрой записи.
// Режимы: микрофон, системный звук, экран, окно, камера.
// Запись — MediaRecorder → webm; файл сохраняется в папку записей и может
// быть сразу отправлен в веб-приложение на расшифровку.
//
// Микрофон и звук системы/экрана смешиваются через AudioContext —
// MediaRecorder не умеет несколько аудиодорожек, поэтому обе сводятся
// в один поток. Старт/стоп записи сообщается главному процессу
// (в трее моргает красная точка).

const $ = (sel) => document.querySelector(sel)
const native = window.stenoNative

// ─── локализация ─────────────────────────────────────────────────────────────
const T = {
  ru: {
    title: 'Быстрая запись',
    hint: 'Выберите, что записывать',
    mic: 'Микрофон',
    system: 'Системный звук',
    screen: 'Экран (видео)',
    window: 'Окно (видео)',
    camera: 'Камера',
    pickScreen: 'Выберите экран',
    pickWindow: 'Выберите окно',
    withAudio: 'со звуком системы',
    withMic: '+ микрофон',
    back: '← Назад',
    stop: '■ Остановить',
    cancel: 'Отмена',
    saved: 'Запись сохранена',
    send: 'Отправить на расшифровку',
    openFolder: 'Открыть папку',
    again: 'Ещё запись',
    noSources: 'Источники не найдены',
    sysAudioFail:
      'Системный звук недоступен. На Windows работает из коробки (WASAPI loopback); на macOS нужен BlackHole, на Linux — PipeWire/PulseAudio monitor.',
  },
  en: {
    title: 'Quick record',
    hint: 'Choose what to record',
    mic: 'Microphone',
    system: 'System audio',
    screen: 'Screen (video)',
    window: 'Window (video)',
    camera: 'Camera',
    pickScreen: 'Choose a screen',
    pickWindow: 'Choose a window',
    withAudio: 'with system audio',
    withMic: '+ microphone',
    back: '← Back',
    stop: '■ Stop',
    cancel: 'Cancel',
    saved: 'Recording saved',
    send: 'Send to transcription',
    openFolder: 'Open folder',
    again: 'Record again',
    noSources: 'No sources found',
    sysAudioFail:
      'System audio unavailable. Works out of the box on Windows (WASAPI loopback); macOS needs BlackHole, Linux needs a PipeWire/PulseAudio monitor source.',
  },
}
let t = T.ru

function applyLang() {
  document.querySelector('header h1').textContent = t.title
  document.querySelector('.hint').textContent = t.hint
  const names = { mic: t.mic, system: t.system, screen: t.screen, window: t.window, camera: t.camera }
  document.querySelectorAll('.mode').forEach((b) => {
    const ico = b.querySelector('.ico')
    b.textContent = ''
    if (ico) b.appendChild(ico)
    b.appendChild(document.createTextNode(names[b.dataset.mode] || b.dataset.mode))
  })
  $('#back-to-modes').textContent = t.back
  $('#stop-rec').textContent = t.stop
  $('#cancel-rec').textContent = t.cancel
  document.querySelector('#done h2').textContent = t.saved
  $('#send-to-app').textContent = t.send
  $('#open-folder').textContent = t.openFolder
  $('#again').textContent = t.again
  document.querySelector('#sys-audio-row').childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) n.textContent = ` ${t.withAudio} `
  })
  document.querySelectorAll('label.row')[1].childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) n.textContent = ` ${t.withMic}`
  })
}

const sections = {
  modes: $('#modes'),
  sources: $('#sources'),
  recording: $('#recording'),
  done: $('#done'),
}

let stream = null
let recorder = null
let chunks = []
let timer = null
let startedAt = 0
let pendingMode = null
let savedFile = null
let audioCtx = null // для сведения микрофона и системного звука

function show(name) {
  for (const [k, el] of Object.entries(sections)) el.classList.toggle('hidden', k !== name)
  $('#error').classList.add('hidden')
}

function fail(e) {
  console.error(e)
  const el = $('#error')
  el.textContent = `${e?.message || e}`
  el.classList.remove('hidden')
  stopStream()
  show('modes')
}

function stopStream() {
  if (recorder && recorder.state !== 'inactive') {
    try {
      recorder.stop()
    } catch {
      /* ignore */
    }
  }
  recorder = null
  if (stream) {
    if (stream.__display) for (const tr of stream.__display.getTracks()) tr.stop()
    for (const tr of stream.getTracks()) tr.stop()
  }
  stream = null
  if (audioCtx) {
    void audioCtx.close().catch(() => {})
    audioCtx = null
  }
  if (timer) clearInterval(timer)
  timer = null
  native.reportRecState(false)
}

// ─── режимы ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode
    if (mode === 'screen' || mode === 'window') {
      pendingMode = mode
      void pickSource(mode)
    } else {
      void startSimple(mode)
    }
  })
})

// микрофон / системный звук / камера — без выбора источника
async function startSimple(mode) {
  try {
    if (mode === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } else if (mode === 'camera') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    } else if (mode === 'system') {
      // системный звук без видео API не отдаёт — берём экран с loopback
      // и используем только аудиодорожку
      await native.requestCapture(null, true)
      const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      for (const tr of s.getVideoTracks()) tr.stop()
      stream = new MediaStream(s.getAudioTracks())
      if (stream.getAudioTracks().length === 0) {
        throw new Error(t.sysAudioFail)
      }
    }
    beginRecording(mode === 'camera' ? 'video' : 'audio')
  } catch (e) {
    fail(e)
  }
}

// экран/окно — сначала выбираем источник
async function pickSource(mode) {
  try {
    const list = await native.listSources()
    const filtered = list.filter((s) => s.kind === mode)
    $('#sources-title').textContent = mode === 'screen' ? t.pickScreen : t.pickWindow
    const wrap = $('#source-list')
    wrap.innerHTML = ''
    for (const s of filtered) {
      const el = document.createElement('button')
      el.className = 'source'
      el.innerHTML = `<img src="${s.thumbnail}" alt=""/><span>${escapeHtml(s.name)}</span>`
      el.addEventListener('click', () => void startDisplay(s.id))
      wrap.appendChild(el)
    }
    if (filtered.length === 0) wrap.innerHTML = `<p class="muted">${t.noSources}</p>`
    show('sources')
  } catch (e) {
    fail(e)
  }
}

/**
 * Сведение аудиодорожек в одну через AudioContext.
 * MediaRecorder пишет только одну аудиодорожку, поэтому звук экрана
 * (loopback) и микрофон микшируются в один поток заранее.
 */
function mixAudio(streams) {
  audioCtx = new AudioContext()
  const dest = audioCtx.createMediaStreamDestination()
  for (const s of streams) {
    for (const track of s.getAudioTracks()) {
      audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest)
    }
  }
  return dest.stream.getAudioTracks()
}

async function startDisplay(sourceId) {
  try {
    const withAudio = $('#with-audio').checked
    const withMic = $('#with-mic').checked
    await native.requestCapture(sourceId, withAudio)
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: withAudio })

    let audioTracks = display.getAudioTracks()
    if (withMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        // смешиваем звук экрана и микрофон в одну дорожку
        audioTracks = mixAudio([display, mic])
        // микрофонный поток должен жить, пока идёт запись:
        // сохраняем его дорожки в основном потоке, чтобы stopStream их закрыл
        for (const tr of mic.getAudioTracks()) display.addTrack(tr)
      } catch {
        /* микрофон опционален */
      }
    }

    stream = new MediaStream([...display.getVideoTracks(), ...audioTracks])
    // оригинальный display-поток тоже держим (для остановки видео-трека)
    stream.__display = display
    beginRecording('video')
  } catch (e) {
    fail(e)
  }
}

// ─── запись ──────────────────────────────────────────────────────────────────
function beginRecording(kind) {
  chunks = []
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm'
  recorder = new MediaRecorder(stream, kind === 'video' ? { mimeType: mime } : undefined)
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.onstop = onStopped
  recorder.start(1000)
  native.reportRecState(true) // в трее моргает красная точка

  const preview = $('#preview')
  if (kind === 'video') {
    preview.srcObject = stream
    preview.classList.remove('hidden')
  } else {
    preview.classList.add('hidden')
  }

  startedAt = Date.now()
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000)
    $('#rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }, 500)
  show('recording')
}

async function onStopped() {
  const kind = $('#preview').classList.contains('hidden') ? 'audio' : 'video'
  const blob = new Blob(chunks, { type: recorder?.mimeType || 'video/webm' })
  const ext = 'webm' // webm несёт и чистое аудио (opus)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `steno-${kind}-${stamp}.${ext}`
  try {
    const buf = await blob.arrayBuffer()
    savedFile = await native.saveRecording(name, buf)
    $('#saved-path').textContent = savedFile
    show('done')
  } catch (e) {
    fail(e)
  } finally {
    native.reportRecState(false)
    if (stream) {
      if (stream.__display) for (const tr of stream.__display.getTracks()) tr.stop()
      for (const tr of stream.getTracks()) tr.stop()
    }
    stream = null
    if (audioCtx) {
      void audioCtx.close().catch(() => {})
      audioCtx = null
    }
  }
}

$('#stop-rec').addEventListener('click', () => {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  if (timer) clearInterval(timer)
  timer = null
})

$('#cancel-rec').addEventListener('click', () => {
  chunks = []
  recorder && (recorder.onstop = null)
  stopStream()
  show('modes')
})

$('#back-to-modes').addEventListener('click', () => show('modes'))

$('#send-to-app').addEventListener('click', async () => {
  if (savedFile) await native.injectFile(savedFile)
  window.close()
})

$('#open-folder').addEventListener('click', async () => {
  if (savedFile) await native.openPath(savedFile)
})

$('#again').addEventListener('click', () => show('modes'))

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// язык интерфейса — из настроек приложения
void (async () => {
  try {
    const state = await native.getState()
    if (state.language === 'en') {
      t = T.en
      document.documentElement.lang = 'en'
    }
    applyLang()
  } catch {
    /* ignore */
  }
})()
