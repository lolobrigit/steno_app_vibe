// Скрипт подготовки локальной веб-версии: клонирует steno_vibe,
// собирает фронтенд и складывает статику в web/dist.
//
//   node scripts/fetch-web.cjs            # свежий main из GitHub
//   node scripts/fetch-web.cjs --local ../steno_vibe   # из локальной копии
//
// Собирается только фронтенд (vite build) — серверная часть в десктопном
// режиме не нужна: распознавание и модели работают в браузерном движке.
//
// ВАЖНО: в steno_vibe фронтенд-библиотеки (react, radix, transformers.js…)
// лежат в dependencies, а не в devDependencies — ставим всё.
//
// CI собирает на Node 20: npm 10.9 (из Node 22) падает на этом дереве
// зависимостей с «Exit handler never called!», npm 10.8 (Node 20) — стабилен.
//
// Окружение:
//   STENO_WEB_REPO — URL репозитория веб-версии (по умолчанию steno_vibe)

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, '.web-src')
const OUT = path.join(ROOT, 'web', 'dist')
const REPO = process.env.STENO_WEB_REPO || 'https://github.com/lolobrigit/steno_vibe.git'

const NPM_ENV = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
}

function tryRun(cmd, cwd, env = process.env) {
  console.log(`$ ${cmd}`)
  try {
    execSync(cmd, { cwd, env, stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

function run(cmd, cwd, env = process.env) {
  if (!tryRun(cmd, cwd, env)) throw new Error(`Command failed: ${cmd}`)
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

/**
 * Полная установка зависимостей с повторами. Перед каждой попыткой
 * node_modules чистится — установка поверх грязного дерева падает с ENOTEMPTY.
 * --ignore-scripts: postinstall (native-бинарники серверной части)
 * для vite build не нужны.
 */
function installDeps() {
  const nm = () => fs.rmSync(path.join(SRC, 'node_modules'), { recursive: true, force: true })
  for (const attempt of [1, 2, 3]) {
    nm()
    console.log(`— установка зависимостей, попытка ${attempt}/3…`)
    if (tryRun('npm install --ignore-scripts', SRC, NPM_ENV)) return
    if (attempt < 3) execSync('sleep 10')
  }
  throw new Error('npm install: все попытки исчерпаны')
}

function main() {
  const localIdx = process.argv.indexOf('--local')
  const localPath = localIdx >= 0 ? process.argv[localIdx + 1] : null

  if (localPath) {
    console.log(`Используем локальную копию: ${localPath}`)
    fs.rmSync(SRC, { recursive: true, force: true })
    copyDir(localPath, SRC)
  } else if (fs.existsSync(path.join(SRC, '.git'))) {
    run('git pull --ff-only', SRC)
  } else {
    fs.rmSync(SRC, { recursive: true, force: true })
    run(`git clone --depth 1 ${REPO} "${SRC}"`, ROOT)
  }

  installDeps()

  // BASE_PATH не задаём — base '/' под наш локальный сервер
  run('npx vite build', SRC, NPM_ENV)

  const distPublic = path.join(SRC, 'dist', 'public')
  if (!fs.existsSync(path.join(distPublic, 'index.html'))) {
    throw new Error(`Не найдена сборка фронтенда: ${distPublic}`)
  }
  copyDir(distPublic, OUT)
  console.log(`\nГотово: ${OUT}`)
}

main()
