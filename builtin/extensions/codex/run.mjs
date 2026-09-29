// codex：在运行目录里让 codex 干一件事，把它的回话包成一段 JSON（见 EXTENSION.md）。
//
// 自己只认两个参数，其余**原样转给 `codex exec`**：
//   `--prompt <md 路径 | 正文>`   提示词。从 stdin 递给 codex（末尾那个 `-`），多长、多少行都行。
//   `--留会话 <true|false>`       false 就补上 `--ephemeral`，这次会话不落盘。
// 唯一的保留词是 `空`（清单里每个开关的默认值），意思是「这条开关不要」，规矩跟 pi 那份一样。
//
// 跑的是 `codex exec --json --dangerously-bypass-approvals-and-sandbox`：不问人、不进沙箱。
// 事件流一行一条 JSON，这个文件把它翻成人话写 **stderr**（诊断）；**stdout 只有最后那一段 JSON**。
// `exec` 是一次性的：stdin 喂完提示词就关，所以这份不收插话（没有 `talk: true`）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const NO_FLAG = '空'
const KEEP_SESSION = '--留会话'
const IS_WINDOWS = process.platform === 'win32'
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
const clipArgs = (args) =>
  Object.fromEntries(Object.entries(args && typeof args === 'object' ? args : {}).map(([key, value]) => [key, typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value]))
function act(tool, args) {
  process.stderr.write(`${atLineStart ? '' : '\n'}${JSON.stringify({ tool, args: clipArgs(args) })}\n`)
  atLineStart = true
}

// 漏出来的裸词：codex 会把它当成**提示词**，stdin 上那份就成了附在后面的 `<stdin>` 块 —— 跑的是另一件事。
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

function quote(value) {
  const text = String(value)
  if (IS_WINDOWS) return `"${text}"`
  return `'${text.replace(/'/g, "'\\''")}'`
}

// Windows 上 codex 是 npm 的 shim（codex.cmd）。能找到它的 js 入口就用本进程的 node 直接起，
// 不经 cmd；找不到才退回 cmd.exe（参数都是单行的，提示词走 stdin，引号裹一层就够）。
function startCodex(args, cwd) {
  if (!IS_WINDOWS) return spawn('codex', args, { cwd })
  const js = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : ''
  if (js && fs.existsSync(js)) return spawn(process.execPath, [js, ...args], { cwd, windowsHide: true })
  const command = ['codex', ...args].map(quote).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
}

function split(argv) {
  const rest = []
  let prompt = ''
  let keepSession = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prompt') {
      prompt = argv[i + 1] ?? ''
      i += 1
    } else if (arg === KEEP_SESSION) {
      const value = argv[i + 1] ?? ''
      if (value !== 'true' && value !== 'false') throw new Error(`${KEEP_SESSION} 只认 true / false，收到「${value}」`)
      keepSession = value === 'true'
      i += 1
    } else if (arg === NO_FLAG) {
      if (rest[rest.length - 1]?.startsWith('-')) rest.pop()
    } else {
      rest.push(arg)
    }
  }
  return { prompt, keepSession, rest }
}

// 提示词：读得到就当文件，读不到且不像路径就当正文本身（判据见 pi 那份）。
const looksLikePath = (value) =>
  !/\s/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && (/[\\/]/.test(value) || /\.(md|markdown|txt)$/i.test(value))
function readPrompt(value) {
  try {
    return fs.readFileSync(value, 'utf8')
  } catch {
    return looksLikePath(value) ? null : value
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

// 不算工具的几类 item：回话、思考、计划、非致命的报错。
const NOT_TOOLS = new Set(['agent_message', 'reasoning', 'todo_list', 'error'])

// codex 的 item → 动作行里的「工具名 + 参数」
function toolOf(item) {
  switch (item.type) {
    case 'command_execution':
      return { name: 'shell', args: { command: item.command } }
    case 'file_change':
      return { name: 'edit', args: { path: (item.changes ?? []).map((change) => `${change.kind ?? ''} ${change.path ?? ''}`.trim()).join(', ') } }
    case 'mcp_tool_call':
      return { name: item.tool ?? 'mcp', args: item.arguments }
    case 'web_search':
      return { name: 'web_search', args: { query: item.query } }
    default:
      return { name: item.type, args: {} }
  }
}

function resultOf(item) {
  if (item.type === 'command_execution') {
    const code = item.exit_code
    return `${summarize(item.aggregated_output)}${code !== null && code !== undefined && code !== 0 ? ` · 退出码 ${code}` : ''}`
  }
  if (item.type === 'mcp_tool_call') {
    if (item.error) return summarize(item.error.message ?? item.error)
    return summarize((item.result?.content ?? []).map((part) => part?.text ?? '').join(''))
  }
  return item.status ?? '完成'
}

const failed = (item) => item.status === 'failed' || (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0)

function startTool(item, state) {
  const { name, args } = toolOf(item)
  state.tools += 1
  state.toolAt.set(item.id, since())
  line(`→ ${describeCall(name, args)}`)
  act(name, args)
}

function finishTool(item, state) {
  // file_change 这类只来一条 completed：没见过它开始，就在这儿补上
  if (!state.toolAt.has(item.id)) startTool(item, state)
  const from = state.toolAt.get(item.id)
  const spent = since() - from
  state.toolMs += spent
  state.toolAt.delete(item.id)
  line(`← ${toolOf(item).name} ${resultOf(item)} · ${(spent / 1000).toFixed(1)}s${failed(item) ? ' ✗' : ''}`)
}

function trace(event, state) {
  const item = event.item ?? {}
  switch (event.type) {
    case 'thread.started':
      line(`· 会话 ${event.thread_id}`)
      break
    case 'turn.started':
      state.turns += 1
      line(`─ 第 ${state.turns} 轮`)
      break
    case 'item.started':
      if (!NOT_TOOLS.has(item.type)) startTool(item, state)
      break
    case 'item.completed':
      if (item.type === 'agent_message') {
        const said = String(item.text ?? '').trim()
        if (said) {
          line(said)
          state.answer = said
        }
      } else if (item.type === 'reasoning') line(`… 想了想（${String(item.text ?? '').length} 字）`)
      else if (item.type === 'error') line(`· ${item.message ?? '出了点错'}`)
      else if (item.type !== 'todo_list') finishTool(item, state)
      break
    case 'turn.failed':
      state.failure = event.error?.message ?? '这一轮失败了'
      line(`✗ ${state.failure}`)
      break
    case 'error':
      state.failure = event.message ?? '出错了'
      line(`✗ ${state.failure}`)
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

const runCodex = (args, input, cwd, state) =>
  new Promise((done) => {
    const child = startCodex(args, cwd)
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
      state.err = `${state.err}${chunk}`.slice(-600)
      raw(chunk)
    })
    child.on('error', (error) => done({ error }))
    child.on('close', (code) => {
      read.flush()
      done({ code: typeof code === 'number' ? code : 1 })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })

try {
  const { prompt, keepSession, rest } = split(process.argv.slice(2))
  if (!prompt) throw new Error('没给 --prompt：节点上的「提示词」还没接上')
  const text = readPrompt(prompt)
  if (text === null) throw new Error(`提示词读不到：${prompt}`)
  const strays = straysIn(rest)
  if (strays.length) {
    const list = strays.map((item) => `「${item}」`).join('')
    throw new Error(`${list}不是开关，会被 codex 当成提示词。开关框的写法看扩展的 args 行：带了前缀的（--model {{模型}}）只填值，整串开关那一栏（{{其它}}）才写 -c model_reasoning_effort=high`)
  }
  // 运行目录不一定是 git 仓库，所以总带 --skip-git-repo-check
  const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...rest]
  if (!keepSession) args.push('--ephemeral')
  args.push('-')
  const state = { lastAt: Date.now(), turns: 0, tools: 0, answer: '', err: '', failure: '', toolAt: new Map(), toolMs: 0 }
  const beat = setInterval(() => {
    const idle = Math.round((Date.now() - state.lastAt) / 1000)
    if (idle >= 20) line(`… 已经 ${idle}s 没有新动静`)
  }, 20000)
  const record = await runCodex(args, text, process.cwd(), state)
  clearInterval(beat)
  if (record.error) throw new Error(`codex 起不来：${record.error.message}`)
  const spent = since() / 1000
  const tools = state.toolMs / 1000
  line(`· codex 退出码 ${record.code} · ${state.tools} 个工具 · ${spent.toFixed(1)}s（工具 ${tools.toFixed(1)}s / 模型 ${(spent - tools).toFixed(1)}s）`)
  const answer = state.answer.trim()
  if (record.code !== 0 || state.failure) {
    const why = state.failure || state.err.trim() || answer || '没有输出'
    say({ ok: false, reason: `codex 退出码 ${record.code}：${why.slice(0, 300)}` })
    process.exitCode = record.code || 1
  } else if (!answer) {
    say({ ok: false, reason: 'codex 没有回话' })
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
