// Крошечный статический сервер для локальной сборки веб-приложения (web/dist).
// HTTP на 127.0.0.1 — это secure context для браузерных API (WebGPU, IndexedDB),
// в отличие от file://. Порт выбирается один раз и сохраняется в настройках,
// чтобы origin (и данные IndexedDB) были стабильны между запусками.

const http = require('http')
const fs = require('fs')
const path = require('path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.map': 'application/json',
}

function startStaticServer(rootDir, settings) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        // SPA: нет файла → index.html
        let file = path.join(rootDir, pathname)
        if (!file.startsWith(rootDir)) {
          res.writeHead(403).end()
          return
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          file = path.join(rootDir, 'index.html')
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        fs.createReadStream(file).pipe(res)
      } catch (e) {
        res.writeHead(500).end(String(e))
      }
    })

    const tryPort = (port, attemptsLeft) => {
      server.once('error', () => {
        if (attemptsLeft > 0) tryPort(0, attemptsLeft - 1)
        else reject(new Error('no free port'))
      })
      server.listen(port, '127.0.0.1', () => {
        const actual = server.address().port
        settings.set('localPort', actual)
        resolve({ server, url: `http://127.0.0.1:${actual}/` })
      })
    }
    // пробуем сохранённый порт, при занятости — случайный (0)
    tryPort(settings.get('localPort') || 0, 1)
  })
}

module.exports = { startStaticServer }
