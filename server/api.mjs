// 本地接口：持有工作文件夹，负责文件读写与命令执行。前端只发相对路径。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CACHE_DIR, CACHE_EXT, CANVAS_FILE, DOCS_DIR, cacheFile } from '../src/core/paths.mjs'

const RECENT_FILE = path.join(os.homedir(), '.mican', 'recent.json')
const SETTINGS_FILE = path.join(os.homedir(), '.mican', 'settings.json')
// 一个命令节点最多跑多久：agent 干活的节点本来就可能跑很久，默认给 2 小时；超时只是防挂死。
// 这台机器上一改就生效（存在 ~/.mican/settings.json），上限 24 小时。
const DEFAULT_TIMEOUT_S = 7200
const MAX_TIMEOUT_S = 24 * 3600
// 一个节点的输出上限：默认 1MB。超了就截断（不杀进程）—— 杀掉等于把 agent 的活白干了。
const DEFAULT_OUTPUT_KB = 1024
const MAX_OUTPUT_KB = 65536
const DEFAULT_RECENT_MAX = 8
const MAX_RECENT_MAX = 50
const MAX_BODY = 32 * 1024 * 1024
const IS_WINDOWS = process.platform === 'win32'

// 命令行：设置里存的是名字，这里落成「怎么起它」。名字不认识就报错，不猜。
// cmd 那条带 chcp：Windows 默认代码页是 GBK，先让子进程尽量说 UTF-8（说不完的 createDecoder 再兜）。
// 命令整串用双引号裹起来 + windowsVerbatimArguments，这两下缺一不可：
// 不这么干，命令里的双引号会原样漏给被调程序 —— findstr /c:"yes" 会去找字面量 "yes"，
// node -e "…" 会收到断成两半的参数。
const SHELLS = {
  cmd: (command) => ({ file: 'cmd.exe', args: ['/d', '/s', '/c', `"chcp 65001>nul && ${command}"`], verbatim: true }),
  sh: (command) => ({ file: '/bin/sh', args: ['-c', command], verbatim: false }),
  bash: (command) => ({ file: 'bash', args: ['-c', command], verbatim: false }),
  powershell: (command) => ({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command], verbatim: false }),
  pwsh: (command) => ({ file: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', command], verbatim: false }),
}

// 空串 = 跟这台机器的默认（Windows 上 cmd，其余 sh）
function shellOf(name, command) {
  const wanted = String(name ?? '').trim().toLowerCase()
  const build = SHELLS[wanted || (IS_WINDOWS ? 'cmd' : 'sh')]
  if (!build) throw new Error(`不认识的行命令行：${name}（可填 ${Object.keys(SHELLS).join(' / ')}）`)
  return build(command)
}

export function createApi(initialRoot) {
  let root = initialRoot ? path.resolve(initialRoot) : null

  function inside(relative) {
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`路径越界：${relative}`)
    return target
  }

  // 最近打开的工作文件夹：存在用户目录里，换浏览器、换端口都还在。
  async function readRecent() {
    try {
      const items = JSON.parse(await fs.readFile(RECENT_FILE, 'utf8'))
      return Array.isArray(items) ? items.filter((item) => typeof item === 'string') : []
    } catch {
      return [] // 没存过、或存坏了，都当没有历史
    }
  }

  async function remember(dir) {
    const items = [dir, ...(await readRecent()).filter((item) => item !== dir)].slice(0, (await readSettings()).recentMax)
    await fs.mkdir(path.dirname(RECENT_FILE), { recursive: true }).catch(() => {})
    await fs.writeFile(RECENT_FILE, JSON.stringify(items, null, 2), 'utf8').catch(() => {})
    return items
  }

  async function setWorkspace(dir, mode) {
    const target = path.resolve(dir)
    if (mode === 'create') {
      await fs.mkdir(target, { recursive: true })
      if ((await fs.readdir(target)).length > 0) throw new Error('目标文件夹不为空')
      root = target
      return { root, canvas: null, cache: {}, recent: await remember(target) }
    }
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('文件夹不存在')
    root = target
    const canvas = await fs
      .readFile(path.join(target, CANVAS_FILE), 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null) // 没有存档就是空文件夹，照样能打开
    return { root, canvas, cache: await readCache(), recent: await remember(target) }
  }

  // 缓存文件：命令节点上次跑出来的裸输出。节点上要显示它，[[ ]] 也指着它。
  // 直接扫目录，不依赖「存档里记了哪些」—— 两次写之间断了也能把孤儿收回来。
  async function readCache() {
    const dir = path.join(root, CACHE_DIR)
    const cache = {}
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (!name.endsWith(CACHE_EXT)) continue
      const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null)
      if (text !== null) cache[name.slice(0, -CACHE_EXT.length)] = text
    }
    return cache
  }

  // 列目录：给界面里的「浏览…」用，只给子目录和外加的上层入口。
  async function listRoots() {
    if (!IS_WINDOWS) return [{ name: '/', path: path.sep }]
    const found = await Promise.all(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
        const drive = `${letter}:\\`
        return (await fs.stat(drive).catch(() => null)) ? { name: drive, path: drive } : null
      }),
    )
    return found.filter(Boolean)
  }

  async function browse(input) {
    const wanted = input ? path.resolve(input) : root ?? os.homedir()
    const start = (await fs.stat(wanted).catch(() => null))?.isDirectory() ? wanted : os.homedir()
    const entries = await fs.readdir(start, { withFileTypes: true }).catch(() => [])
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: path.join(start, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const parent = path.dirname(start)
    return { path: start, parent: parent === start ? null : parent, dirs, roots: await listRoots() }
  }

  // 上次落盘的画布：用来知道哪些文件是 MiCan 写的，清理时只动自己写过的那些。
  async function lastCanvas() {
    try {
      return JSON.parse(await fs.readFile(path.join(root, CANVAS_FILE), 'utf8'))
    } catch {
      return null
    }
  }

  async function save({ canvas, docs = [], cache = [] }) {
    if (!root) throw new Error('还没有工作文件夹')
    const previous = await lastCanvas()

    await fs.mkdir(path.join(root, DOCS_DIR), { recursive: true })
    for (const doc of docs) {
      const target = inside(doc.file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, doc.content ?? '', 'utf8')
    }

    // 缓存文件：命令节点的裸输出，跑完一个写一个，[[ ]] 指着它要。
    if (cache.length) await fs.mkdir(path.join(root, CACHE_DIR), { recursive: true })
    for (const item of cache) await fs.writeFile(inside(cacheFile(item.id)), item.content ?? '', 'utf8')

    // 缓存目录是 MiCan 自己独占的，直接按目录清：存档没记上的孤儿也一并收掉。
    // docs 里混着用户自己放的文件，所以那边只能按「上次存档说是我的」来清。
    const cacheDir = path.join(root, CACHE_DIR)
    const keepCache = new Set(cache.map((item) => item.id))
    for (const name of await fs.readdir(cacheDir).catch(() => [])) {
      if (!name.endsWith(CACHE_EXT) || keepCache.has(name.slice(0, -CACHE_EXT.length))) continue
      await fs.rm(path.join(cacheDir, name), { force: true })
    }

    // 只有文本节点才有 md 文件：按 file 存不存在判断，不能按 kind 反推 ——
    // 会跑的节点（命令、提取）都没有 file，而 previous 是直接读的存档、没校验过。
    const keepDocs = new Set(docs.map((doc) => doc.file))
    for (const node of previous?.nodes ?? []) {
      if (!node.file || keepDocs.has(node.file)) continue
      await fs.rm(inside(node.file), { force: true })
    }

    // 画布存档最后写 —— 它相当于提交。
    await fs.writeFile(path.join(root, CANVAS_FILE), JSON.stringify(canvas, null, 2), 'utf8')
  }

  // 逐块解码：UTF-8 优先，块里出现替换字符时按 GBK 重来（cmd 内建消息走的是 OEM 代码页）。
  // stream: true 会把块尾截断的多字节字符留到下一块，不会被当成坏编码。
  function createDecoder() {
    const utf8 = new TextDecoder('utf8')
    return (chunk) => {
      if (!chunk?.length) return ''
      const text = utf8.decode(chunk, { stream: true })
      if (!text.includes('\ufffd')) return text
      try {
        return new TextDecoder('gbk').decode(chunk)
      } catch {
        return text
      }
    }
  }

  function kill(child) {
    if (child.exitCode !== null || child.signalCode) return
    if (!IS_WINDOWS) {
      child.kill()
      return
    }
    // windows 上 kill 只杀 shell，命令自己的子进程会漏下来，连整棵树一起收
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref()
    } catch {
      child.kill()
    }
  }

  // 设置文件是外来的（手改、旧版本、写坏了）：范围外夹住，不是数就用默认。
  const clampInt = (value, def, min, max) => (Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : def)

  // 全局配置：跟这台机器走，不进画布存档 —— 命令行、超时、输出上限都是这台机器上的事。
  // 后端只认识自己用的那几个；界面手感那些它不认识，原样带着走（免得前端加一项配置就得改后端）。
  async function readSettings() {
    try {
      const stored = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'))
      const data = stored && typeof stored === 'object' ? stored : {}
      // 运行目录已经搬进存档（ADR-0008）了：清掉旧的全局那份，下一次写设置它就从文件里消失。
      delete data.cwd
      return {
        ...data,
        shell: typeof data.shell === 'string' ? data.shell : '',
        timeout: clampInt(data.timeout, DEFAULT_TIMEOUT_S, 1, MAX_TIMEOUT_S),
        outputLimitKb: clampInt(data.outputLimitKb, DEFAULT_OUTPUT_KB, 1, MAX_OUTPUT_KB),
        recentMax: clampInt(data.recentMax, DEFAULT_RECENT_MAX, 1, MAX_RECENT_MAX),
      }
    } catch {
      // 没设过、或存坏了，都当没设
      return { shell: '', timeout: DEFAULT_TIMEOUT_S, outputLimitKb: DEFAULT_OUTPUT_KB, recentMax: DEFAULT_RECENT_MAX }
    }
  }

  async function writeSettings(patch) {
    const next = { ...(await readSettings()), ...patch }
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true }).catch(() => {})
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
    return next
  }

  // 命令行和超时都得是认识的值：报错就退回去让用户重填，不静默改掉他写的字。
  function checkShell(value) {
    const wanted = String(value ?? '').trim().toLowerCase()
    if (!wanted) return ''
    if (!SHELLS[wanted]) throw new Error(`不认识的行命令行：${value}（可填 ${Object.keys(SHELLS).join(' / ')}）`)
    return wanted
  }

  function checkTimeout(value) {
    const seconds = Math.round(Number(value))
    if (!Number.isFinite(seconds) || seconds < 1) throw new Error(`超时得是大于 0 的秒数：${value}`)
    return Math.min(seconds, MAX_TIMEOUT_S)
  }

  function checkOutputLimit(value) {
    const kb = Math.round(Number(value))
    if (!Number.isFinite(kb) || kb < 1) throw new Error(`输出上限得是大于 0 的 KB 数：${value}`)
    return Math.min(kb, MAX_OUTPUT_KB)
  }

  function checkRecentMax(value) {
    const count = Math.round(Number(value))
    if (!Number.isFinite(count) || count < 1) throw new Error(`最近打开的条数得是大于 0 的整数：${value}`)
    return Math.min(count, MAX_RECENT_MAX)
  }

  // 本机路径只收绝对路径；运行目录那一类允许相对工作文件夹的路径，不在后端管（它在存档里，跑的时候才拼）。
  function requireAbsolute(value, what = '路径') {
    const wanted = String(value ?? '').trim()
    if (!wanted) return ''
    if (!path.isAbsolute(wanted)) throw new Error(`${what}要写成绝对路径：${wanted}`)
    return path.resolve(wanted)
  }

  // 命令的运行目录：空就是工作文件夹；相对路径按工作文件夹算（“.” 就是它自己）；
  // 绝对路径按本机路径。落地的必须是一个真实存在的文件夹。
  async function resolveCwd(cwd) {
    const wanted = String(cwd ?? '').trim()
    if (!wanted || !root) return root
    const target = path.isAbsolute(wanted) ? path.resolve(wanted) : path.resolve(root, wanted)
    if (!(await fs.stat(target).catch(() => null))?.isDirectory()) throw new Error(`运行目录不存在：${target}`)
    return target
  }

  // 运行命令：边跑边把输出按 NDJSON 行推给前端，最后一行是终止信息。
  // options 是这台机器上的设置：用哪个命令行、最多跑多久、输出最多收多少。
  function run(command, cwd, res, options) {
    let launch
    try {
      launch = shellOf(options.shell, command)
    } catch (error) {
      return send(res, 400, { error: error.message }) // 还没推流，报得成 JSON
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    })
    const emit = (line) => res.write(`${JSON.stringify(line)}\n`)
    const done = (line) => {
      emit(line)
      res.end()
    }

    if (!root) return done({ type: 'exit', code: 1, failed: true, output: '还没有工作文件夹' })

    const child = spawn(launch.file, launch.args, { cwd, windowsHide: true, windowsVerbatimArguments: launch.verbatim })
    child.stdin.end() // 给子进程一个 EOF：不关 stdin 时，会读 stdin 的命令（如 pi -p）会一直挂到超时

    const decode = createDecoder()
    let bytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      kill(child)
    }, options.timeout * 1000)

    function onData(chunk) {
      if (truncated) return
      const room = options.outputLimit - bytes
      bytes += chunk.length
      if (chunk.length > room) {
        // 超上限：切掉多出来的部分，但**不杀进程** —— 杀掉等于把 agent 的活白干了。
        // 之后还往外写的一律丢掉，等它自己跑完；节点上会标「输出被截断」。
        truncated = true
        if (room > 0) emit({ type: 'chunk', data: decode(chunk.subarray(0, room)) })
        return
      }
      emit({ type: 'chunk', data: decode(chunk) })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    function close(extra) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(extra)
    }

    child.on('error', (error) => close({ type: 'exit', code: 1, failed: true, output: error.message }))
    child.on('close', (code) => {
      const exit = typeof code === 'number' ? code : 1
      close({ type: 'exit', code: exit, failed: exit !== 0 || timedOut || truncated, timedOut, truncated })
    })
    res.on('close', () => {
      if (!settled) kill(child)
    })
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  }

  function send(res, status, payload) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(payload))
  }

  return async function handleApi(req, res, next) {
    if (!req.url?.startsWith('/api/')) return next()
    const route = req.url.split('?')[0]
    try {
      if (req.method !== 'POST') throw new Error('只接受 POST')
      const body = await readBody(req)
      if (route === '/api/workspace') return send(res, 200, await setWorkspace(body.path, body.mode))
      if (route === '/api/recent') return send(res, 200, { items: await readRecent() })
      // 不传 cwd 是读，传了（哪怕是空串）就是写
      if (route === '/api/settings') {
        // 一个键都没带就是读；带了哪个键就改哪个键（命令行和超时能单独改）
        const patch = {}
        if (typeof body.shell === 'string') patch.shell = checkShell(body.shell)
        if (body.timeout !== undefined) patch.timeout = checkTimeout(body.timeout)
        if (body.outputLimitKb !== undefined) patch.outputLimitKb = checkOutputLimit(body.outputLimitKb)
        if (body.recentMax !== undefined) patch.recentMax = checkRecentMax(body.recentMax)
        if (typeof body.openWorkspace === 'string') patch.openWorkspace = requireAbsolute(body.openWorkspace, '启动时打开的工作文件夹')
        // 界面上那堆手感值（节点尺寸、缩放范围…）后端不认识，原样存着走 —— 免得前端加一项配置就得改后端。
        // 只收标量：外来请求里塞对象、数组的一律丢掉。
        for (const [key, value] of Object.entries(body)) {
          if (key in patch) continue
          if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) patch[key] = value
        }
        // shells 是给界面摆下拉用的，认哪些名字是后端的事；它只是个回参，不进存档。
        const answer = (settings) => send(res, 200, { ...settings, shells: Object.keys(SHELLS) })
        if (!Object.keys(patch).length) return answer(await readSettings())
        return answer(await writeSettings(patch))
      }
      if (route === '/api/browse') return send(res, 200, await browse(body.path))
      if (route === '/api/save') {
        await save(body)
        return send(res, 200, { ok: true })
      }
      if (route === '/api/exec') {
        const { shell, timeout, outputLimitKb } = await readSettings()
        return run(String(body.command ?? ''), await resolveCwd(body.cwd), res, { shell, timeout, outputLimit: outputLimitKb * 1024 })
      }
      throw new Error(`未知接口：${route}`)
    } catch (error) {
      if (res.headersSent) return res.end() // 已经在推流，报不了 JSON 了
      send(res, 400, { error: error.message })
    }
  }
}
