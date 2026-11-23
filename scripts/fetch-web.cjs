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
// Установка через pnpm (corepack): npm на GitHub Actions детерминированно
// падает на этом дереве зависимостей с «Exit handler never called!»
// (и 10.8 на Node 20, и 10.9 на Node 22) — обходим его полностью.
// Фолбэк на npm сохранён для локальных запусков без corepack.
//
// Успех проверяется по факту наличия node_modules/.bin/vite, а не по
// коду выхода — npm умеет падать уже после полной распаковки пакетов.
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
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
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

/** vite собран, только если бинарник на месте. */
function viteInstalled() {
  return fs.existsSync(path.join(SRC, 'node_modules', '.bin', 'vite'))
}

/**
 * Установка зависимостей. Порядок: pnpm (corepack) → npm.
 * Перед каждой попыткой node_modules чистится полностью — установка
 * поверх грязного дерева падает с ENOTEMPTY.
 * Скрипты пакетов отключены (native-бинарники серверной части
 * для vite build не нужны).
 */
function installDeps() {
  const nm = () => fs.rmSync(path.join(SRC, 'node_modules'), { recursive: true, force: true })

  // ── путь 1: pnpm через corepack ──
  nm()
  console.log('— включаем corepack/pnpm…')
  if (tryRun('corepack enable && corepack prepare pnpm@9.15.4 --activate', ROOT, NPM_ENV)) {
    for (const attempt of [1, 2]) {
      nm()
      console.log(`— pnpm install, попытка ${attempt}/2…`)
      if (tryRun('pnpm install --ignore-scripts', SRC, NPM_ENV) && viteInstalled()) return
      console.warn('pnpm: vite не появился, пробуем ещё')
    }
  } else {
    console.warn('corepack недоступен — сразу npm')
  }

  // ── путь 2: npm ──
  for (const attempt of [1, 2, 3]) {
    nm()
    console.log(`— npm install, попытка ${attempt}/3…`)
    tryRun('npm install --ignore-scripts', SRC, NPM_ENV) // код выхода не важен
    if (viteInstalled()) {
      console.log('npm отработал (vite на месте)')
      return
    }
    if (attempt < 3) execSync('sleep 10')
  }
  throw new Error('установка зависимостей: все способы исчерпаны (vite не найден)')
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
