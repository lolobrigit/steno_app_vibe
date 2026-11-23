// Скрипт подготовки локальной веб-версии: клонирует steno_vibe,
// собирает фронтенд и складывает статику в web/dist.
//
//   node scripts/fetch-web.cjs            # свежий main из GitHub
//   node scripts/fetch-web.cjs --local ../steno_vibe   # из локальной копии
//
// Собирается только фронтенд (vite build) — серверная часть в десктопном
// режиме не нужна: распознавание и модели работают в браузерном движке.
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

// npm на GH Actions периодически падает с «Exit handler never called!»;
// отключаем самые хрупкие части.
const NPM_ENV = {
  ...process.env,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_foreground_scripts: 'true',
  npm_config_prefer_online: 'true',
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
 * Установка зависимостей веб-приложения.
 * Стратегия 1: только фронтенд-зависимости (devDependencies) — меньше пакетов,
 *   меньше шансов на баги npm; серверные (hono, drizzle, mysql2…) не нужны.
 * Стратегия 2: полный npm install с чистого листа.
 * Между попытками node_modules удаляется полностью — повторная установка
 * поверх грязного дерева падает с ENOTEMPTY.
 */
function installDeps() {
  const pkgPath = path.join(SRC, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const nm = () => fs.rmSync(path.join(SRC, 'node_modules'), { recursive: true, force: true })

  // Vite 7 тянет rollup native-бинарник; на Node 22 ставим Vite 6 — быстрее и без native
  pkg.dependencies = { ...(pkg.dependencies || {}), vite: '^6.3.5' }

  for (const attempt of [1, 2, 3]) {
    nm()
    if (attempt === 1) {
      const minimal = { ...pkg, dependencies: { vite: '^6.3.5' } }
      fs.writeFileSync(pkgPath, JSON.stringify(minimal, null, 2))
      console.log('— попытка 1: только фронтенд-зависимости (devDependencies)…')
      if (tryRun('npm install --ignore-scripts', SRC, NPM_ENV)) return
      console.warn('не вышло, пробуем полную установку')
    } else {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
      console.log(`— попытка ${attempt}: полный npm install…`)
      if (tryRun('npm install --ignore-scripts', SRC, NPM_ENV)) return
    }
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
  fs.rmSync(path.join(SRC, 'node_modules'), { recursive: true, force: true })

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
