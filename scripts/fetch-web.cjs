// Скрипт подготовки локальной веб-версии: клонирует steno_vibe,
// собирает фронтенд и складывает статику в web/dist.
//
//   node scripts/fetch-web.cjs            # свежий main из GitHub
//   node scripts/fetch-web.cjs --local ../steno_vibe   # из локальной копии
//
// Собирается только фронтенд (vite build) — серверная часть в десктопном
// режиме не нужна: распознавание и модели работают в браузерном движке.

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, '.web-src')
const OUT = path.join(ROOT, 'web', 'dist')
const REPO = 'https://github.com/lolobrigit/steno_vibe.git'

function run(cmd, cwd) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name)
    const d = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function main() {
  const localIdx = process.argv.indexOf('--local')
  const localPath = localIdx >= 0 ? process.argv[localIdx + 1] : null

  if (localPath) {
    console.log(`Используем локальную копию: ${localPath}`)
    fs.rmSync(SRC, { recursive: true, force: true })
    copyDir(localPath, SRC)
    fs.rmSync(path.join(SRC, 'node_modules'), { recursive: true, force: true })
  } else if (fs.existsSync(path.join(SRC, '.git'))) {
    run('git pull --ff-only', SRC)
  } else {
    fs.rmSync(SRC, { recursive: true, force: true })
    run(`git clone --depth 1 ${REPO} "${SRC}"`, ROOT)
  }

  run('npm install', SRC)
  run('npx vite build', SRC) // BASE_PATH не задаём — base '/' под наш локальный сервер

  const distPublic = path.join(SRC, 'dist', 'public')
  if (!fs.existsSync(path.join(distPublic, 'index.html'))) {
    throw new Error(`Не найдена сборка фронтенда: ${distPublic}`)
  }
  copyDir(distPublic, OUT)
  console.log(`\nГотово: ${OUT}`)
}

main()
