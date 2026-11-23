// Логика окна быстрой записи.
// Режимы: микрофон, системный звук, экран, окно, камера.
// Запись — MediaRecorder → webm; файл сохраняется в папку записей и может
// быть сразу отправлен в веб-приложение на расшифровку.

const $ = (sel) => document.querySelector(sel)
const native = window.stenoNative

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

function show(name) {
  for (const [k, el] of Object.entries(sections)) el.classList.toggle('hidden', k !== name)
  $('#error').classList.add('hidden')
}

function fail(e) {
  console.error(e)
  const el = $('#error')
  el.textContent = `Ошибка: ${e?.message || e}`
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
  if (stream) for (const t of stream.getTracks()) t.stop()
  stream = null
  if (timer) clearInterval(timer)
  timer = null
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
      for (const t of s.getVideoTracks()) t.stop()
      stream = new MediaStream(s.getAudioTracks())
      if (stream.getAudioTracks().length === 0) {
        throw new Error(
          'Системный звук недоступен. На Windows работает из коробки (WASAPI loopback); на macOS нужен BlackHole, на Linux — PipeWire/PulseAudio monitor.',
        )
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
    $('#sources-title').textContent = mode === 'screen' ? 'Выберите экран' : 'Выберите окно'
    const wrap = $('#source-list')
    wrap.innerHTML = ''
    for (const s of filtered) {
      const el = document.createElement('button')
      el.className = 'source'
      el.innerHTML = `<img src="${s.thumbnail}" alt=""/><span>${escapeHtml(s.name)}</span>`
      el.addEventListener('click', () => void startDisplay(s.id))
      wrap.appendChild(el)
    }
    if (filtered.length === 0) wrap.innerHTML = '<p class="muted">Источники не найдены</p>'
    show('sources')
  } catch (e) {
    fail(e)
  }
}

async function startDisplay(sourceId) {
  try {
    const withAudio = $('#with-audio').checked
    const withMic = $('#with-mic').checked
    await native.requestCapture(sourceId, withAudio)
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: withAudio })
    if (withMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        for (const t of mic.getAudioTracks()) stream.addTrack(t)
      } catch {
        /* микрофон опционален */
      }
    }
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
  const ext = kind === 'video' ? 'webm' : 'webm' // webm несёт и чистое аудио (opus)
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
    if (stream) for (const t of stream.getTracks()) t.stop()
    stream = null
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
