// 本地接口：持有工作文件夹，负责文件读写与命令执行。前端只发相对路径。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const CANVAS_FILE = 'mican.json'
const DOCS_DIR = 'docs'
const EXEC_TIMEOUT_MS = 120_000
const EXEC_MAX_OUTPUT = 64 * 1024
const MAX_BODY = 32 * 1024 * 1024
const IS_WINDOWS = process.platform === 'win32'

export function createApi(initialRoot) {
  let root = initialRoot ? path.resolve(initialRoot) : null

  function inside(relative) {
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`路径越界：${relative}`)
    return target
  }

  async function setWorkspace(dir, mode) {
    const target = path.resolve(dir)
    if (mode === 'create') {
      await fs.mkdir(target, { recursive: true })
      if ((await fs.readdir(target)).length > 0) throw new Error('目标文件夹不为空')
      root = target
      return { root, canvas: null }
    }
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('文件夹不存在')
    root = target
    const canvas = await fs
      .readFile(path.join(target, CANVAS_FILE), 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null) // 没有存档就是空文件夹，照样能打开
    return { root, canvas }
  }

  async function save({ canvas, docs = [], remove = [] }) {
    if (!root) throw new Error('还没有工作文件夹')
    await fs.mkdir(path.join(root, DOCS_DIR), { recursive: true })
    // 先把 md 全部处理完，画布存档最后写 —— 它相当于提交。
    for (const doc of docs) {
      const target = inside(doc.file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, doc.content ?? '', 'utf8')
    }
    for (const file of remove) await fs.rm(inside(file), { force: true })
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

  // 运行命令：边跑边把输出按 NDJSON 行推给前端，最后一行是终止信息。
  function run(command, res) {
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

    const shell = IS_WINDOWS ? 'cmd.exe' : '/bin/sh'
    // Windows 默认代码页是 GBK，让子进程尽量说 UTF-8；说不了的下面再兜
    const args = IS_WINDOWS ? ['/d', '/s', '/c', `chcp 65001>nul && ${command}`] : ['-c', command]
    const child = spawn(shell, args, { cwd: root, windowsHide: true })
    child.stdin.end() // 给子进程一个 EOF：不关 stdin 时，会读 stdin 的命令（如 pi -p）会一直挂到超时

    const decode = createDecoder()
    let bytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      kill(child)
    }, EXEC_TIMEOUT_MS)

    function onData(chunk) {
      if (truncated) return
      const room = EXEC_MAX_OUTPUT - bytes
      bytes += chunk.length
      if (chunk.length > room) {
        truncated = true
        if (room > 0) emit({ type: 'chunk', data: decode(chunk.subarray(0, room)) })
        kill(child)
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
      if (route === '/api/save') {
        await save(body)
        return send(res, 200, { ok: true })
      }
      if (route === '/api/exec') return run(String(body.command ?? ''), res)
      throw new Error(`未知接口：${route}`)
    } catch (error) {
      if (res.headersSent) return res.end() // 已经在推流，报不了 JSON 了
      send(res, 400, { error: error.message })
    }
  }
}
