// Менеджер моделей: загрузка по прямым ссылкам в выбранную папку.
//
// Контракт (совпадает с docs/NATIVE_APPS.md веб-версии, раздел 3.2):
// - очередь, по одной загрузке за раз;
// - возобновление с того же байта (HTTP Range), в том числе после перезапуска;
// - проверка свободного места до начала;
// - отмена удаляет частичные данные.
//
// Ссылки принимаются вида:
//   https://huggingface.co/<owner>/<model>/resolve/<rev>/<file...>
//   https://hf-mirror.co/... (то же дерево)
//   или произвольная прямая ссылка на файл.
// Для ссылок HF файл складывается по «родному» пути репозитория, чтобы
// перехватчик протокола (см. modelsProtocol в main.cjs) мог подставлять
// локальные файлы вместо скачивания из сети.

const fs = require('fs')
const path = require('path')
const { net } = require('electron')

const STATE_FILE = 'steno-downloads.json'

/** Разбор ссылки → относительный путь в папке моделей. */
function urlToRelPath(url) {
  const u = new URL(url)
  const m = u.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/resolve\/([^/]+)\/(.+)$/)
  if (m) return path.join(m[1], 'resolve', m[2], m[3])
  // произвольная ссылка: host/путь, чтобы не было коллизий имён
  return path.join('_direct', u.hostname, u.pathname.replace(/^\/+/, ''))
}

class Downloads {
  constructor(app, settings, notify) {
    this.dir = app.getPath('userData')
    this.settings = settings
    this.notify = notify // (state) => void — состояние очереди для окна
    this.stateFile = path.join(this.dir, STATE_FILE)
    /** @type {Array<{id:string,url:string,relPath:string,total:number,received:number,status:string,error?:string}>} */
    this.jobs = []
    this.running = null
    this.abortCtrl = null
    try {
      this.jobs = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      // «running» при перезапуске → «paused», докачаем при старте
      for (const j of this.jobs) if (j.status === 'running') j.status = 'paused'
    } catch {
      this.jobs = []
    }
  }

  modelsRoot() {
    return this.settings.get('modelsDir') || path.join(this.dir, 'models')
  }

  persist() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.jobs, null, 2))
    } catch {
      /* ignore */
    }
    this.notify(this.list())
  }

  list() {
    return { jobs: this.jobs, modelsDir: this.modelsRoot() }
  }

  /** Сколько байт уже лежит в .part — возобновление с этого места. */
  partSize(job) {
    try {
      return fs.statSync(path.join(this.modelsRoot(), job.relPath + '.part')).size
    } catch {
      return 0
    }
  }

  freeSpace() {
    try {
      return fs.statfsSync(this.modelsRoot()).bavail * 512
    } catch {
      return null
    }
  }

  add(url) {
    const relPath = urlToRelPath(url)
    const dup = this.jobs.find((j) => j.relPath === relPath && j.status !== 'error')
    if (dup) {
      if (dup.status === 'paused' || dup.status === 'error') this.resume(dup.id)
      return dup
    }
    const job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      relPath,
      total: 0,
      received: 0,
      status: 'queued',
    }
    this.jobs.push(job)
    this.persist()
    void this.pump()
    return job
  }

  resume(id) {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    job.status = 'queued'
    job.error = undefined
    this.persist()
    void this.pump()
  }

  cancel(id) {
    const idx = this.jobs.findIndex((j) => j.id === id)
    if (idx < 0) return
    const job = this.jobs[idx]
    if (this.running?.id === id && this.abortCtrl) this.abortCtrl.abort()
    // отмена удаляет частичные данные (контракт 3.2)
    for (const suffix of ['.part', '']) {
      try {
        fs.unlinkSync(path.join(this.modelsRoot(), job.relPath + suffix))
      } catch {
        /* ignore */
      }
    }
    this.jobs.splice(idx, 1)
    this.persist()
  }

  removeDone() {
    this.jobs = this.jobs.filter((j) => j.status !== 'done')
    this.persist()
  }

  async pump() {
    if (this.running) return
    const job = this.jobs.find((j) => j.status === 'queued')
    if (!job) return
    this.running = job
    this.abortCtrl = new AbortController()
    job.status = 'running'
    this.persist()
    try {
      await this.downloadOne(job, this.abortCtrl.signal)
      job.status = 'done'
      job.received = job.total || job.received
    } catch (e) {
      if (this.abortCtrl.signal.aborted) {
        // отмена — задание уже удалено из списка в cancel()
      } else {
        job.status = 'paused'
        job.error = e instanceof Error ? e.message : String(e)
      }
    } finally {
      this.running = null
      this.abortCtrl = null
      this.persist()
      void this.pump()
    }
  }

  async downloadOne(job, signal) {
    const finalPath = path.join(this.modelsRoot(), job.relPath)
    const partPath = finalPath + '.part'
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })

    const resumeFrom = this.partSize(job)
    job.received = resumeFrom

    const headers = {}
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

    const res = await net.fetch(job.url, { headers, signal, redirect: 'follow' })
    if (!res.ok && res.status !== 206) {
      // сервер не принял Range — начинаем с нуля
      if (resumeFrom > 0 && res.status === 200) {
        fs.rmSync(partPath, { force: true })
        job.received = 0
      } else {
        throw new Error(`HTTP ${res.status}`)
      }
    }

    const total = Number(res.headers.get('content-length') || 0)
    const cr = res.headers.get('content-range')
    const totalFromRange = cr ? Number(cr.split('/')[1]) : 0
    job.total = totalFromRange || (resumeFrom + total) || job.total
    this.persist()

    // проверка свободного места (двойной объём не нужен — пишем сразу в .part)
    const free = this.freeSpace()
    if (free !== null && job.total > 0 && free < job.total - resumeFrom) {
      throw new Error(`Не хватает места: нужно ~${job.total - resumeFrom} байт, свободно ${free}`)
    }

    const out = fs.createWriteStream(partPath, { flags: resumeFrom > 0 && res.status === 206 ? 'a' : 'w' })
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) {
        out.destroy()
        return
      }
      await new Promise((resolve, reject) =>
        out.write(value, (e) => (e ? reject(e) : resolve())),
      )
      job.received += value.length
      if (job.received % (4 * 1024 * 1024) < 65536) this.persist() // прогресс раз в ~4 МБ
    }
    await new Promise((resolve) => out.end(resolve))
    fs.renameSync(partPath, finalPath)
  }
}

module.exports = { Downloads, urlToRelPath }
