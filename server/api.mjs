// 本地接口：持有工作文件夹，负责文件读写与命令执行。前端只发相对路径。
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const CANVAS_FILE = 'mican.json'
const DOCS_DIR = 'docs'
const EXEC_TIMEOUT_MS = 15_000
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

  function decode(buffer) {
    if (!buffer?.length) return ''
    const utf8 = buffer.toString('utf8')
    if (!IS_WINDOWS || !utf8.includes('\ufffd')) return utf8
    try {
      return new TextDecoder('gbk').decode(buffer) // cmd 内建消息走的是 OEM 代码页
    } catch {
      return utf8
    }
  }

  function run(command) {
    return new Promise((resolve) => {
      if (!root) {
        resolve({ code: 1, output: '还没有工作文件夹', failed: true })
        return
      }
      const shell = IS_WINDOWS ? 'cmd.exe' : '/bin/sh'
      // Windows 默认代码页是 GBK，让子进程尽量说 UTF-8；说不了的下面再兜
      const args = IS_WINDOWS ? ['/d', '/s', '/c', `chcp 65001>nul && ${command}`] : ['-c', command]
      const options = { cwd: root, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_OUTPUT, encoding: 'buffer', windowsHide: true }
      execFile(shell, args, options, (error, stdout, stderr) => {
        const truncated = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        const timedOut = Boolean(error?.killed) && !truncated
        const raw = error && stderr.length ? stderr : stdout
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          output: decode(raw),
          failed: Boolean(error),
          timedOut,
          truncated,
        })
      })
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
      if (route === '/api/exec') return send(res, 200, await run(String(body.command ?? '')))
      throw new Error(`未知接口：${route}`)
    } catch (error) {
      send(res, 400, { error: error.message })
    }
  }
}
