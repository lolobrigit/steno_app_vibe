// Генерация build/icon.png (512×512) без зависимостей — чистый Node.
// Запускается автоматически через npm "prepare", можно и вручную:
//   node scripts/make-icon.cjs
//
// Дизайн: скруглённый квадрат с сине-индиго градиентом и белой аудио-волной.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const S = 512
const RADIUS = 110
const MARGIN = 8
const TOP = [62, 92, 235]
const BOT = [32, 40, 120]

// детерминированный ГПСЧ (высоты столбиков волны)
let seed = 7
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

// параметры волны
const BARS = 17
const BW = 14
const GAP = 12
const totalW = BARS * BW + (BARS - 1) * GAP
const x0 = S / 2 - totalW / 2
const cy = S / 2
const heights = []
for (let i = 0; i < BARS; i++) {
  const env = Math.sin((Math.PI * i) / (BARS - 1))
  heights.push(60 + env * 200 * (0.55 + 0.45 * rnd()))
}

const px = Buffer.alloc(S * S * 4)

function insideRoundRect(x, y, x1, y1, x2, y2, r) {
  if (x < x1 || x > x2 || y < y1 || y > y2) return false
  const cxr = Math.max(x1 + r, Math.min(x, x2 - r))
  const cyr = Math.max(y1 + r, Math.min(y, y2 - r))
  const dx = x - cxr
  const dy = y - cyr
  return dx * dx + dy * dy <= r * r
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4
    if (!insideRoundRect(x, y, MARGIN, MARGIN, S - MARGIN, S - MARGIN, RADIUS)) {
      px[o + 3] = 0 // прозрачный фон за пределами иконки
      continue
    }
    const t = y / S
    let r = TOP[0] + (BOT[0] - TOP[0]) * t
    let g = TOP[1] + (BOT[1] - TOP[1]) * t
    let b = TOP[2] + (BOT[2] - TOP[2]) * t
    let a = 255
    // волна
    for (let i = 0; i < BARS; i++) {
      const bx = x0 + i * (BW + GAP)
      const h = heights[i]
      if (x >= bx && x <= bx + BW && y >= cy - h / 2 && y <= cy + h / 2) {
        if (insideRoundRect(x, y, bx, cy - h / 2, bx + BW, cy + h / 2, BW / 2)) {
          r = 255
          g = 255
          b = 255
          a = 235
          break
        }
      }
    }
    px[o] = r
    px[o + 1] = g
    px[o + 2] = b
    px[o + 3] = a
  }
}

// ─── PNG-кодирование ─────────────────────────────────────────────────────────
const CRC_TABLE = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, '..', 'build', 'icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log(`icon written: ${out} (${png.length} bytes)`)
