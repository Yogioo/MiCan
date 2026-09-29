// 更新：从 GitHub 的 release 换掉整个发行包（ADR-0033）。
// 版本源是包根那份 version.json（scripts/pack.mjs 出包时写的）；仓库里没有它 —— 开发模式下只查不装。
// 搬文件的人不是正在跑的这个进程：把手头的包下好、解好，写一个小脚本丢到临时目录里脱手拉开，自己退出。
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'Yogioo/MiCan'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
// 下好的包、解出来的东西、那个脚本都住在这儿；下一次下载开始时整份清掉
const STAGE_ROOT = path.join(os.tmpdir(), 'mican-update')
// 起来之后先等一会儿再问 GitHub（别跟开局抢时间），之后每 6 小时问一次
const FIRST_DELAY_MS = 30 * 1000
const CHECK_EVERY_MS = 6 * 3600 * 1000
// 预置好了但手头正忙：过一阵再看一眼，而不是等下一个 6 小时
const RETRY_MS = 5 * 60 * 1000
// 「人没在写」的判据：这段时间内没有落盘
const QUIET_MS = 60 * 1000
// 退出前留给这次请求回话的时间
const EXIT_DELAY_MS = 1500
const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// 本机这份包是哪个目标：跟 scripts/pack.mjs 的 TARGETS 一一对应（那边认的名字、这边认的也一样）
function targetOf() {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  return ''
}

// 0.1.4 / v0.1.4：按数字逐段比，缺的段当 0。不认 pre-release（够用就行）
function compare(a, b) {
  const parts = (value) => String(value ?? '').replace(/^v/i, '').split('-')[0].split('.').map((n) => Math.round(Number(n)) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  return 0
}

function run(file, args) {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { stdio: 'ignore' })
    child.on('error', fail)
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`${path.basename(file)} 退出码 ${code}`))))
  })
}

// 包根那份 version.json 说了「我是哪个版本、哪个平台」；没有它就是仓库（开发模式）
async function readLocal(target) {
  const manifest = await fs.readFile(path.join(APP_ROOT, 'version.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (manifest?.version) {
    return { version: String(manifest.version), packaged: existsSync(path.join(APP_ROOT, 'runtime')) }
  }
  const pkg = await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8').then(JSON.parse).catch(() => null)
  return { version: String(pkg?.version ?? ''), packaged: false }
}

// 解出来的那份包根：压缩包里顶层就是 MiCan-<目标>，认它里面有没有 server/serve.mjs
async function packageRoot(into) {
  for (const name of await fs.readdir(into).catch(() => [])) {
    const candidate = path.join(into, name)
    if (await fs.stat(path.join(candidate, 'server', 'serve.mjs')).catch(() => null)) return candidate
  }
  throw new Error('下下来的包里没找着 server/serve.mjs')
}

export function createUpdater({ readSettings, idle = () => true, lastSaveAt = () => 0 }) {
  const target = targetOf()
  let local = { version: '', packaged: false }
  // 盘上那份：起手读一次就定了（进程活着的时候不会有人换它 —— 换了也已经是新的在跑）
  const reading = readLocal(target).then((found) => {
    local = found
  })

  let latest = ''
  let page = ''
  let asset = null // { name, url }
  let checkedAt = 0
  let error = ''
  let stage = '' // 预置好的那份包根；'' 就是还没下
  let stagedVersion = ''
  let restarting = false
  let busy = '' // '' | 'check' | 'download' | 'apply'
  let timer = null

  // 每次轮询都带回去，只放便宜的东西（发布说明那种长文本不进这里）
  function status() {
    return {
      current: local.version,
      target,
      packaged: local.packaged,
      latest,
      hasUpdate: Boolean(latest) && compare(latest, local.version) > 0,
      assetOk: Boolean(asset),
      staged: Boolean(stage),
      stagedVersion,
      restarting,
      busy,
      error,
      url: page,
      checkedAt,
      auto: timer !== null,
    }
  }

  async function check() {
    busy = 'check'
    try {
      const answer = await fetch(RELEASE_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'MiCan' },
      })
      if (answer.status === 404) throw new Error('这个仓库还没有发布过版本')
      if (!answer.ok) throw new Error(`GitHub 没答理（${answer.status}${answer.status === 403 ? '，未登录时一小时只能问 60 次' : ''}）`)
      const release = await answer.json()
      latest = String(release.tag_name ?? '').replace(/^v/i, '')
      page = String(release.html_url ?? '')
      asset =
        (release.assets ?? [])
          .map((item) => ({ name: String(item.name ?? ''), url: String(item.browser_download_url ?? '') }))
          .find((item) => item.name.startsWith(`MiCan-${target}.`)) ?? null
      checkedAt = Date.now()
      error = ''
    } catch (failure) {
      error = failure.message
    } finally {
      busy = ''
    }
    return status()
  }

  // 下载 + 解压到临时目录。装的那份就是解出来的那份包根，之后只搬运、不再问网络。
  async function download() {
    if (!local.version) throw new Error('这份包没有版本号，更新不了')
    if (!local.packaged) throw new Error('开发模式（没有 version.json 与 runtime/），改的是仓库，不自动更新')
    if (!target) throw new Error(`这个平台还没有对应的包：${process.platform}/${process.arch}`)
    if (!latest) await check()
    if (!status().hasUpdate) throw new Error(`已经是最新的了（${local.version}）`)
    if (!asset) throw new Error(`这次发布里没有 ${target} 的包`)
    if (stage && stagedVersion === latest) return status()
    busy = 'download'
    try {
      await fs.rm(STAGE_ROOT, { recursive: true, force: true })
      await fs.mkdir(STAGE_ROOT, { recursive: true })
      const archive = path.join(STAGE_ROOT, asset.name)
      const answer = await fetch(asset.url)
      if (!answer.ok) throw new Error(`下载失败（${answer.status}）`)
      // 先写 .part 再改名：中途断了不会留下一份「看着像下好了」的
      await pipeline(Readable.fromWeb(answer.body), createWriteStream(`${archive}.part`))
      await fs.rename(`${archive}.part`, archive)
      const into = path.join(STAGE_ROOT, 'pkg')
      await fs.mkdir(into, { recursive: true })
      if (archive.endsWith('.zip')) {
        // 只有 Windows 的包是 zip（scripts/pack.mjs），别的平台拿到 zip 就说明名字对不上
        if (!IS_WINDOWS) throw new Error(`这个平台的包不该是 zip：${asset.name}`)
        await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`])
      } else {
        await run('tar', ['-xzf', archive, '-C', into])
      }
      stage = await packageRoot(into)
      stagedVersion = latest
      error = ''
    } finally {
      busy = ''
    }
    return status()
  }

  // 那个脱手的脚本：等这个 pid 消失 → 把新包整份盖上去 → 删掉解压那层与下载的压缩包 → 用启动器重新起来。
  // 它住在临时目录里，删得掉自己下面和旁边的东西；自己删不掉自己，留着，下次下载开始时一并清掉。
  function scriptText() {
    const app = APP_ROOT
    const pkg = stage
    const home = STAGE_ROOT
    const pid = process.pid
    if (IS_WINDOWS) {
      return [
        '@echo off',
        'rem 等旧的那一份让开：node.exe 在 Windows 上是锁着的，进程不退就换不掉',
        `powershell -NoProfile -Command "while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }"`,
        `robocopy "${pkg}" "${app}" /E /NFL /NDL /NJH /NJS /NP > "${home}\\apply.log"`,
        'rem 0 到 7 都算没出错（robocopy 的规矩）；搬没搬完看那份 log',
        'if errorlevel 8 (',
        `  echo 更新没搬完，看 ${home}\\apply.log`,
        ') else (',
        `  del /q "${home}\\*.zip" "${home}\\apply.log" >nul 2>&1`,
        ')',
        `rmdir /s /q "${pkg}" >nul 2>&1`,
        `cd /d "${app}"`,
        'start "MiCan" cmd /c "MiCan.bat"',
      ].join('\r\n')
    }
    const restart = IS_MAC
      ? [`chmod +x "${app}/MiCan.command" 2>/dev/null`, `open "${app}/MiCan.command"`]
      : [`chmod +x "${app}/MiCan.sh" "${app}/runtime/node" 2>/dev/null`, `setsid nohup "${app}/MiCan.sh" >/dev/null 2>&1 &`]
    return [
      '#!/bin/sh',
      '# 等旧的那一份让开',
      `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
      `cp -R "${pkg}/." "${app}/"`,
      `rm -rf "${pkg}" "${home}/"*.zip "${home}/"*.tar.gz 2>/dev/null`,
      `cd "${app}"`,
      ...restart,
      '',
    ].join('\n')
  }

  async function apply() {
    if (!local.packaged) throw new Error('开发模式（没有 version.json 与 runtime/），改的是仓库，不自动更新')
    if (!stage) await download()
    busy = 'apply'
    const script = path.join(STAGE_ROOT, IS_WINDOWS ? 'apply.bat' : 'apply.sh')
    await fs.writeFile(script, scriptText())
    if (!IS_WINDOWS) await fs.chmod(script, 0o755)
    const child = IS_WINDOWS
      ? spawn('cmd', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('sh', [script], { detached: true, stdio: 'ignore' })
    child.unref()
    restarting = true
    // 先把这次请求答完，再退 —— 端口一空，脚本那边就开始搬
    setTimeout(() => process.exit(0), EXIT_DELAY_MS).unref()
    return status()
  }

  // 自动那条路：问一次 → 该装就下好预置 → 手头空着、人没在写，就装上。
  // 不满足条件的那些就是等，等的时候短一点再看一眼。
  async function tick() {
    timer = null
    let wait = 0
    try {
      const settings = await readSettings()
      const on = settings.autoUpdate !== false
      if (stage && stagedVersion === latest && on) {
        if (idle() && Date.now() - lastSaveAt() > QUIET_MS) return void (await apply())
        wait = RETRY_MS
      } else {
        await check()
        if (on && status().hasUpdate && asset) {
          await download()
          if (idle() && Date.now() - lastSaveAt() > QUIET_MS) return void (await apply())
          wait = RETRY_MS
        }
      }
    } catch (failure) {
      error = failure.message
    }
    timer = setTimeout(tick, wait || CHECK_EVERY_MS)
    timer.unref?.()
  }

  return {
    status,
    check,
    download,
    apply,
    async start() {
      await reading
      timer = setTimeout(tick, FIRST_DELAY_MS)
      timer.unref?.()
      return status()
    },
  }
}
