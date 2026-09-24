// 组装一份「下载就能跑」的 MiCan：自带 node 运行时，双击脚本起它。
//
// 这里没有编译 —— 只是把 node 官方的预编译包原样搬进来。所以不必在目标平台上构建，
// 在 Windows 上也能把 mac / linux 的目录摆好（CI 里就是四个平台各跑一次自己的那份）。
// 唯一的例外是最后那一步压缩：zip 存不下 Unix 的执行位，mac 的 .command 少了它双击不起来，
// 所以 mac / linux 的包各在该平台上压。跨平台组装时下面会提醒一句。
//
// 用法：node scripts/pack.mjs [win-x64|mac-arm64|mac-x64|linux-x64|all]（不给就是当前平台）
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 下过的运行时留着：官方包三十几兆，反复试的时候不必每次重下。
const CACHE = path.join(os.tmpdir(), 'mican-pack-cache')
const OUT_ROOT = path.join(APP_ROOT, 'release')
// 跟本机对齐，免得开发时一个版本、发出去另一个。CI 上用 NODE_VERSION 钉死。
const NODE_VERSION = process.env.NODE_VERSION ?? process.version

const TARGETS = {
  'win-x64': { node: 'win-x64', zipped: true, bin: 'node.exe', script: 'MiCan.bat' },
  'mac-arm64': { node: 'darwin-arm64', zipped: false, bin: 'bin/node', script: 'MiCan.command' },
  'mac-x64': { node: 'darwin-x64', zipped: false, bin: 'bin/node', script: 'MiCan.command' },
  'linux-x64': { node: 'linux-x64', zipped: false, bin: 'bin/node', script: 'MiCan.sh' },
}

// 双击脚本：只干一件事 —— 用旁边那个自带的 node 起 serve.mjs。
// 不写 pause：关窗口就是停服务，跑挂了才停住让人看得见错误。
const LAUNCHERS = {
  'win-x64': '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" server\\serve.mjs\r\nif errorlevel 1 pause\r\n',
  'mac-arm64': '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./runtime/node server/serve.mjs\n',
  'mac-x64': '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./runtime/node server/serve.mjs\n',
  'linux-x64': '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./runtime/node server/serve.mjs\n',
}

const run = (file, args, options = {}) => {
  const result = spawnSync(file, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${file} 退出码 ${result.status}`)
}

function currentTarget() {
  const { platform, arch } = process
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  throw new Error(`这个平台还没有对应的目标：${platform}/${arch}`)
}

async function fetchRuntime(target) {
  const t = TARGETS[target]
  const name = `node-${NODE_VERSION}-${t.node}.${t.zipped ? 'zip' : 'tar.gz'}`
  const archive = path.join(CACHE, name)
  const unpacked = path.join(CACHE, name.replace(/\.(zip|tar\.gz)$/, ''))
  await fs.mkdir(CACHE, { recursive: true })

  if (!(await fs.stat(path.join(unpacked, t.bin)).catch(() => null))) {
    if (!(await fs.stat(archive).catch(() => null))) {
      const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}`
      console.log(`下载运行时 ${url}`)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`下载失败（${response.status}）：${url}`)
      // 先写 .part 再改名：中途断了不会留下一份「看着像下好了」的缓存
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.part`))
      await fs.rename(`${archive}.part`, archive)
    }
    console.log(`解压 ${name}`)
    await fs.rm(unpacked, { recursive: true, force: true })
    // 解到 CACHE 而不是 unpacked：两种压缩包里的顶层本来就是这个目录名，
    // 解到上一级才正好落成 unpacked（Expand-Archive 还会自己再套一层，也是这个落法）。
    // Windows 官方的包是 zip，GNU tar 不认；换 PowerShell 的 Expand-Archive，各版本 Windows 都有
    if (t.zipped) {
      run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${CACHE}' -Force`])
    } else {
      run('tar', ['-xzf', archive, '-C', CACHE])
    }
  }
  return unpacked
}

async function assemble(target, unpacked) {
  const out = path.join(OUT_ROOT, `MiCan-${target}`)
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })

  // 界面：vite 的产物，dist 之外没别的
  await fs.cp(path.join(APP_ROOT, 'dist'), path.join(out, 'dist'), { recursive: true })
  // 后端，外加它真正用到的那部分前端代码（src/core：图的算法、存档格式、路径约定）。
  // src/ui 是给 vite 打包用的，已经在 dist 里了，不重复带。
  await fs.cp(path.join(APP_ROOT, 'server'), path.join(out, 'server'), { recursive: true })
  await fs.cp(path.join(APP_ROOT, 'src', 'core'), path.join(out, 'src', 'core'), { recursive: true })
  // 内置扩展库和工作文件夹的种子。它不是第二层运行时 —— 就是个拷贝源 —— 但路径是从 server/ 往上退一级算的，
  // 所以必须跟 server/ 保持同级，少一层都找不到。
  await fs.cp(path.join(APP_ROOT, 'builtin'), path.join(out, 'builtin'), { recursive: true })
  // 用语正文（CONTEXT.md）在仓库里只有一份、只在根上维护，所以它在包里的家也是根目录：
  // workspace-docs.mjs 是从 server/ 往上退一级去拿它的。不带这一份，新建工作文件夹会当场报错。
  await fs.copyFile(path.join(APP_ROOT, 'CONTEXT.md'), path.join(out, 'CONTEXT.md')).catch(() => {})

  const runtime = path.join(out, 'runtime')
  await fs.mkdir(runtime, { recursive: true })
  await fs.copyFile(path.join(unpacked, TARGETS[target].bin), path.join(runtime, TARGETS[target].zipped ? 'node.exe' : 'node'))
  // node 是 MIT，带上它的许可证
  await fs.copyFile(path.join(unpacked, 'LICENSE'), path.join(runtime, 'LICENSE')).catch(() => {})

  const launcher = path.join(out, TARGETS[target].script)
  await fs.writeFile(launcher, LAUNCHERS[target])
  if (!TARGETS[target].zipped) await fs.chmod(launcher, 0o755)
  return out
}

async function compress(target, out) {
  const t = TARGETS[target]
  if (t.zipped) {
    const zip = `${out}.zip`
    await fs.rm(zip, { force: true })
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force`])
    return zip
  }
  const tgz = `${out}.tar.gz`
  await fs.rm(tgz, { force: true })
  const args = ['-czf', tgz]
  // 在 Windows 上打别的平台的包时，文件的 Unix 权限是猜的：把执行位钉死，
  // 免得 mac 的 .command 解出来不能双击。（bsdtar 不认 --mode，所以只在自己需要的时候加。）
  if (process.platform === 'win32') args.push('--mode=755')
  args.push('-C', path.dirname(out), path.basename(out))
  run('tar', args)
  return tgz
}

if (!(await fs.stat(path.join(APP_ROOT, 'dist', 'index.html')).catch(() => null))) {
  console.error('没有 dist/：先跑一次 npm run build。')
  process.exit(1)
}

const wanted = process.argv[2] ?? currentTarget()
const targets = wanted === 'all' ? Object.keys(TARGETS) : [wanted]
for (const target of targets) {
  if (!TARGETS[target]) throw new Error(`不认识的目标：${target}（可填 ${Object.keys(TARGETS).join(' / ')} / all）`)
  const archive = await compress(target, await assemble(target, await fetchRuntime(target)))
  console.log(`好了：${path.relative(APP_ROOT, archive)}`)
  if (!TARGETS[target].zipped && process.platform !== 'darwin' && process.platform !== 'linux') {
    console.log('  （这个包是在别的平台上压的，执行位是脚本钉的；正式发的时候让 CI 在各自平台上压）')
  }
}
