// agent：在运行目录里让 Cursor Agent 干一件事，把它的回话包成一段 JSON（见 EXTENSION.md）。
//
// 自己只认 `--prompt <md 路径 | 正文>`，其余**原样转给 agent**。
// 唯一的保留词是 `空`（清单里每个开关的默认值），意思是「这条开关不要」，规矩跟 pi 那份一样。
//
// 跑的是 `agent -p --yolo --trust --output-format stream-json <提示词>`：什么命令都直接跑，
// 工作区信任也不问。事件流一行一条 JSON，翻成人话写 **stderr**；**stdout 只有最后那一段 JSON**。
// `-p` 是一次性的，所以这份不收插话（没有 `talk: true`）。
//
// 提示词**只能走命令行参数**（`-p` 不读 stdin）。所以 Windows 上不经 agent.cmd / agent.ps1 ——
// 多行的提示词过不了 cmd 和 PowerShell 那两层引号 —— 而是直接用它自带的 node.exe 起 index.js。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const NO_FLAG = '空'
const IS_WINDOWS = process.platform === 'win32'
// Windows 一整条命令行最长 32767 个字符；提示词超过这个数就改成「去读这份文件」
const PROMPT_LIMIT = 24000
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

// ---- 诊断那条路（stderr）：时间栏、回话、动作行，跟 pi 那份一个样 ----
const BAR = 7
const startedAt = Date.now()
const since = () => Date.now() - startedAt
const stamp = (at) => `${(at / 1000).toFixed(1).padStart(BAR - 1)}s `
let atLineStart = true

function raw(text) {
  process.stderr.write(text)
  if (text.length) atLineStart = text.endsWith('\n')
}

function emit(text, at = since()) {
  const bar = stamp(at)
  let rest = text
  let out = ''
  while (rest.length) {
    if (atLineStart) {
      out += bar
      atLineStart = false
    }
    const cut = rest.indexOf('\n')
    if (cut < 0) {
      out += rest
      break
    }
    out += rest.slice(0, cut + 1)
    rest = rest.slice(cut + 1)
    atLineStart = true
  }
  process.stderr.write(out)
}

const line = (text = '', at) => emit(`${atLineStart ? '' : '\n'}${text}\n`, at)

// 动作行：一步一行 JSON，不带时间栏（扩展约定，给诊断扩展读；画布显示时藏掉）。
// agent 的参数里夹着一堆执行细节（超时、解析结果、说明、各种 id）。诊断扩展拿第一个字符串认步子，
// 所以认得出的那几个键（ARG_KEYS）在就只留它们；都不在才退回「原始值、去掉 id」。
const clipArgs = (args) => {
  const entries = Object.entries(args && typeof args === 'object' ? args : {})
    .filter(([key, value]) => ['string', 'number', 'boolean'].includes(typeof value) && !/id$/i.test(key))
  const known = entries.filter(([key]) => ARG_KEYS.includes(key))
  return Object.fromEntries((known.length ? known : entries)
    .map(([key, value]) => [key, typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value]))
}
function act(tool, args) {
  process.stderr.write(`${atLineStart ? '' : '\n'}${JSON.stringify({ tool, args: clipArgs(args) })}\n`)
  atLineStart = true
}

// 漏出来的裸词：agent 会把它拼进**提示词**里 —— 跑的是另一件事。
function straysIn(rest) {
  const strays = []
  let expectValue = false
  for (const item of rest) {
    if (item.startsWith('-')) expectValue = true
    else if (expectValue) expectValue = false
    else strays.push(item)
  }
  return strays
}

// %LOCALAPPDATA%\cursor-agent\versions\<最新>\{node.exe,index.js}，跟 agent.ps1 挑版本的办法一样
function cursorAgentInstall() {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'cursor-agent') : ''
  const versions = base && path.join(base, 'versions')
  const names = versions && fs.existsSync(versions)
    ? fs.readdirSync(versions, { withFileTypes: true })
      .filter((item) => item.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(item.name))
      .map((item) => item.name)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    : []
  for (const name of names) {
    const node = path.join(versions, name, 'node.exe')
    const index = path.join(versions, name, 'index.js')
    if (fs.existsSync(node) && fs.existsSync(index)) return { node, index }
  }
  return null
}

function startAgent(args, cwd) {
  if (!IS_WINDOWS) return spawn('agent', args, { cwd })
  const install = cursorAgentInstall()
  if (!install) throw new Error('找不到 Cursor Agent 的安装：%LOCALAPPDATA%\\cursor-agent\\versions\\<版本>\\node.exe')
  return spawn(install.node, [install.index, ...args], { cwd, windowsHide: true, env: { ...process.env, CURSOR_INVOKED_AS: 'agent' } })
}

function split(argv) {
  const rest = []
  let prompt = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prompt') {
      prompt = argv[i + 1] ?? ''
      i += 1
    } else if (arg === NO_FLAG) {
      if (rest[rest.length - 1]?.startsWith('-')) rest.pop()
    } else {
      rest.push(arg)
    }
  }
  return { prompt, rest }
}

// 提示词：读得到就当文件，读不到且不像路径就当正文本身（判据见 pi 那份）。
const looksLikePath = (value) =>
  !/\s/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && (/[\\/]/.test(value) || /\.(md|markdown|txt)$/i.test(value))
function readPrompt(value) {
  try {
    return { text: fs.readFileSync(value, 'utf8'), file: path.resolve(value) }
  } catch {
    return looksLikePath(value) ? null : { text: value, file: '' }
  }
}

// ---- 事件流翻成人话 ----

const ARG_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name']
function describeCall(name, args = {}) {
  const key = ARG_KEYS.find((item) => typeof args[item] === 'string' && args[item].trim())
  const value = String(key ? args[key] : Object.values(args).find((item) => typeof item === 'string') ?? '')
  const text = value.trim().replace(/\s+/g, ' ')
  return text ? `${name} ${text.length > 120 ? `${text.slice(0, 120)}…` : text}` : name
}

function summarize(text) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!clean) return '没有输出'
  const rows = clean.split('\n')
  const head = rows[0].length > 100 ? `${rows[0].slice(0, 100)}…` : rows[0]
  return rows.length > 1 ? `${head}（共 ${rows.length} 行）` : head
}

// `{"tool_call":{"shellToolCall":{"args":{…},"result":{…}}}}` → 工具名 shell，参数、结果
function toolOf(event) {
  const call = event.tool_call ?? {}
  const key = Object.keys(call).find((item) => item.endsWith('ToolCall')) ?? Object.keys(call)[0] ?? 'tool'
  const body = call[key] ?? {}
  return { name: key.replace(/ToolCall$/, ''), args: body.args ?? {}, result: body.result }
}

// 结果的形状随工具和版本变：成功时挑最像输出的那一段，失败时给那句错
const OUTPUT_KEYS = ['interleavedOutput', 'stdout', 'content', 'output', 'text', 'message']
function describeResult(result) {
  if (!result || typeof result !== 'object') return { text: '完成', failed: false }
  if (result.error) return { text: summarize(result.error.message ?? result.error.error ?? JSON.stringify(result.error)), failed: true }
  const success = result.success ?? result
  const key = OUTPUT_KEYS.find((item) => typeof success?.[item] === 'string')
  const code = success?.exitCode
  const failed = typeof code === 'number' && code !== 0
  return { text: `${key ? summarize(success[key]) : '完成'}${failed ? ` · 退出码 ${code}` : ''}`, failed }
}

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
  : String(message?.content ?? ''))

function trace(event, state) {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') line(`· 会话 ${event.session_id ?? '?'} · ${event.model ?? '默认模型'}`)
      break
    case 'assistant': {
      const said = textOf(event.message).trim()
      if (said) {
        line(said)
        state.answer = said
      }
      break
    }
    case 'thinking':
      if (event.subtype === 'completed') line('… 想了想')
      break
    case 'tool_call': {
      const { name, args, result } = toolOf(event)
      const id = event.call_id ?? ''
      if (event.subtype === 'started') {
        state.tools += 1
        state.toolAt.set(id, since())
        line(`→ ${describeCall(name, args)}`)
        act(name, args)
      } else if (event.subtype === 'completed') {
        const from = state.toolAt.get(id)
        const spent = from === undefined ? 0 : since() - from
        state.toolMs += spent
        state.toolAt.delete(id)
        const done = describeResult(result)
        line(`← ${name} ${done.text}${from === undefined ? '' : ` · ${(spent / 1000).toFixed(1)}s`}${done.failed ? ' ✗' : ''}`)
      }
      break
    }
    case 'result':
      if (typeof event.result === 'string' && event.result.trim()) state.answer = event.result
      if (event.is_error) state.failure = String(event.result || event.subtype || '这一轮失败了')
      break
  }
}

function makeReader(onLine) {
  let buffer = ''
  return {
    push(text) {
      buffer += text
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const row = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (row.trim()) onLine(row)
      }
    },
    flush() {
      if (buffer.trim()) onLine(buffer)
      buffer = ''
    },
  }
}

const runAgent = (args, cwd, state) =>
  new Promise((done) => {
    const child = startAgent(args, cwd)
    line(`· 起于 ${cwd}`, 0)
    const read = makeReader((row) => {
      let event = null
      try {
        event = JSON.parse(row)
      } catch {
        line(row)
        return
      }
      trace(event, state)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      state.lastAt = Date.now()
      read.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      state.lastAt = Date.now()
      // 留开头不留结尾：agent 的报错是第一句（「Cannot use this model: …」），后面可能跟一长串可选项
      if (state.err.length < 600) state.err = `${state.err}${chunk}`.slice(0, 600)
      raw(chunk)
    })
    child.on('error', (error) => done({ error }))
    child.on('close', (code) => {
      read.flush()
      done({ code: typeof code === 'number' ? code : 1 })
    })
    child.stdin.on('error', () => {})
    child.stdin.end()
  })

try {
  const { prompt, rest } = split(process.argv.slice(2))
  if (!prompt) throw new Error('没给 --prompt：节点上的「提示词」还没接上')
  const input = readPrompt(prompt)
  if (input === null) throw new Error(`提示词读不到：${prompt}`)
  const strays = straysIn(rest)
  if (strays.length) {
    const list = strays.map((item) => `「${item}」`).join('')
    throw new Error(`${list}不是开关，会被 agent 拼进提示词。开关框的写法看扩展的 args 行：带了前缀的（--model {{模型}}）只填值，整串开关那一栏（{{其它}}）才写 --approve-mcps`)
  }
  let message = input.text
  if (message.length > PROMPT_LIMIT) {
    if (!input.file) throw new Error(`提示词有 ${message.length} 字，塞不进命令行：放到文本节点上再连过来`)
    message = `Open and follow every instruction in this file exactly: ${input.file.replace(/\\/g, '/')}`
    line(`· 提示词 ${input.text.length} 字，太长，改成让它去读 ${input.file}`)
  }
  const args = ['-p', '--yolo', '--trust', '--output-format', 'stream-json', ...rest, message]
  const state = { lastAt: Date.now(), tools: 0, answer: '', err: '', failure: '', toolAt: new Map(), toolMs: 0 }
  const beat = setInterval(() => {
    const idle = Math.round((Date.now() - state.lastAt) / 1000)
    if (idle >= 20) line(`… 已经 ${idle}s 没有新动静`)
  }, 20000)
  const record = await runAgent(args, process.cwd(), state)
  clearInterval(beat)
  if (record.error) throw new Error(`agent 起不来：${record.error.message}`)
  const spent = since() / 1000
  const tools = state.toolMs / 1000
  line(`· agent 退出码 ${record.code} · ${state.tools} 个工具 · ${spent.toFixed(1)}s（工具 ${tools.toFixed(1)}s / 模型 ${(spent - tools).toFixed(1)}s）`)
  const answer = state.answer.trim()
  if (record.code !== 0 || state.failure) {
    const why = state.failure || state.err.trim() || answer || '没有输出'
    say({ ok: false, reason: `agent 退出码 ${record.code}：${why.slice(0, 300)}` })
    process.exitCode = record.code || 1
  } else if (!answer) {
    say({ ok: false, reason: 'agent 没有回话' })
  } else {
    const payload = { ok: true, text: answer }
    let inner = null
    try {
      inner = answer.startsWith('{') ? JSON.parse(answer) : null
    } catch {}
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      for (const [key, value] of Object.entries(inner)) {
        if (key === 'ok') continue
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') payload[key] = value
      }
    }
    say(payload)
  }
} catch (error) {
  line(`✗ ${error.message}`)
  say({ ok: false, reason: error.message })
  process.exitCode = 1
}
