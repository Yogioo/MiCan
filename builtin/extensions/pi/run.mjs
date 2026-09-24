// pi：在运行目录里让 pi 干一件事，把它的回话包成一段 JSON（见 EXTENSION.md）。
//
// 自己只认三个参数，其余**原样转给 pi**：
//   `--prompt <md 路径 | 正文>`   提示词。长的那样给路径（多行的进不了命令行）；短的直接把字写在这儿就行。
//   `--留会话 <true|false>`  没填会话 id 时：留就什么都不加，不留就补上 `--no-session`。
//   `--会话 <id>`            有值就 `--session-id <id>`（没有就建、有就续）；空就当没这栏。
//
// 「原样转给 pi」的意思是：节点上那四个开关框里写什么，pi 就收到什么（`--provider sub2api`、
// `--tools read,bash`……）。唯一的保留词是 `空`（清单里每个开关的默认值），意思是「这条开关不要」：
// 清单带了前缀的（`--provider {{提供商}}`）连前面那个开关一起抹掉，清单是整串的（`{{工具}}`）
// 就抹掉它自己。所以加开关只用改 EXTENSION.md，不用改这个文件。
//
// **跑的是 `--mode json`，不是 `-p`**：`-p` 只吐回话，它在干什么一概看不见；`--mode json` 把
// 每一步（第几轮、调了哪个工具、说了什么）都吐成一行 JSON。这个文件把那些行翻成人话写 **stderr** ——
// 那是「诊断」那条路，MiCan 把它铺在节点的正文上，跑完还存成 .log 边车文件。
// **stdout 仍然只有一段 JSON**：值那条路一点没变，下游照样解析。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'

// 开关框里写它 = 这个开关不加任何参数（见 EXTENSION.md）。
const NO_FLAG = '空'
// 自己认的两个名字：留会话是 true / false；会话是钥匙，空就当没填。
const KEEP_SESSION = '--留会话'
const SESSION_ID = '--会话'
const IS_WINDOWS = process.platform === 'win32'
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

// 回话若本身是一段 JSON 对象，把它自己的原始值键抄到顶层（不覆盖 ok）。
function parseObject(text) {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('{')) return null
  try {
    const data = JSON.parse(raw)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

// ---- 诊断那条路（stderr）----
// 每一行前面都带一根时间栏：从起跑算到第几秒。这是「时间」最要紧的表达 ——
// 没有它，「八步跑了十秒」和「一步卡了三分钟」在正文上长得一模一样。
const BAR = 7
let startedAt = Date.now() // 时间栏的零点：进程起来的那一刻
const since = () => Date.now() - startedAt
const stamp = (at) => `${(at / 1000).toFixed(1).padStart(BAR - 1)}s `

// 字节原样交出去（编码归 MiCan 那边的解码器管），只顺手记一下末尾是不是换行。
// 拿到的是 Buffer 还是字符串都得认：pi 自己报错时吐的是一整块 Buffer。
function raw(text) {
  process.stderr.write(text)
  if (!text.length) return
  const tail = typeof text === 'string' ? text.charCodeAt(text.length - 1) : text[text.length - 1]
  atLineStart = tail === 10
}

// 回话是一小块一小块来的，动作是一行一行的 —— 所以得知道此刻是不是在行首，
// 不然时间栏会插进半句回话中间。atLineStart 就为这一件事。
let atLineStart = true

// 带时间栏输出：行首补时间栏，回话里自带的换行也跟着补。
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

// line 是「整行的东西」：不在行首就先补一个换行 —— 回话可能正停在一行中间。
const line = (text = '', at) => emit(`${atLineStart ? '' : '\n'}${text}\n`, at)

// 动作行：一步一行 JSON，不带时间栏（扩展约定，给诊断扩展读；画布显示时藏掉）。
// 字符串参数截短：write 的整份文件内容进来会把 .log 撑大，诊断只要认得出是哪一步。
const clipArgs = (args) =>
  Object.fromEntries(Object.entries(args && typeof args === 'object' ? args : {}).map(([key, value]) => [key, typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value]))
function act(tool, args) {
  process.stderr.write(`${atLineStart ? '' : '\n'}${JSON.stringify({ tool, args: clipArgs(args) })}\n`)
  atLineStart = true
}

// 转发给 pi 的东西里，哪些词会被它当成**提示词**？跟在开关后面的第一个词算那个开关的值，
// 剩下的裸词就是漏出来的 —— 它们不报错，只会让 agent 多收到一条独立的消息，所以值得喊一声。
function straysIn(rest) {
  const strays = []
  let expectValue = false
  for (const item of rest) {
    if (item.startsWith('-')) {
      expectValue = true
    } else if (expectValue) {
      expectValue = false
    } else {
      strays.push(item)
    }
  }
  return strays
}

// 参数值都是开关名、模型名、工具名和路径，引号裹一层就够用。
function quote(value) {
  const text = String(value)
  if (IS_WINDOWS) return `"${text}"` // Windows 的文件名里没有双引号
  return `'${text.replace(/'/g, "'\\''")}'` // sh：单引号里一切安全，除了单引号自己
}

// pi 是 npm 的 shim，Windows 上落成 pi.cmd —— CreateProcess 只认 .exe，起不来它，得让 cmd 来解析。
// 一经 cmd 引号就得自己管：整个命令行裹一层双引号 + windowsVerbatimArguments，让 cmd 原样收到
// （Node 不再自己补一层）—— 跟 MiCan 跑命令时是同一套办法。
function startPi(args, cwd) {
  if (!IS_WINDOWS) return spawn('pi', args, { cwd, shell: false })
  const command = ['pi', ...args].map(quote).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd, windowsVerbatimArguments: true })
}

// argv 里 --prompt / --留会话 / --会话 归自己，`空` 滤掉，其余一个不动地留给 pi。
function split(argv) {
  const rest = []
  let prompt = ''
  let keepSession = false
  let sessionId = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prompt') {
      prompt = argv[i + 1] ?? ''
      i += 1
    } else if (arg === KEEP_SESSION) {
      const value = argv[i + 1] ?? ''
      // 布尔就认这两个词：写错了宁可停下来，也别猜它想要什么
      if (value !== 'true' && value !== 'false') throw new Error(`${KEEP_SESSION} 只认 true / false，收到「${value}」`)
      keepSession = value === 'true'
      i += 1
    } else if (arg === SESSION_ID) {
      const value = argv[i + 1] ?? ''
      i += 1
      sessionId = value === NO_FLAG ? '' : value
    } else if (arg === NO_FLAG) {
      // `空` = 「这条开关不要」。清单里写成 `--provider {{提供商}}`（框里只填值）时，
      // 它就落在开关后面 —— 得把那个光秃秃的开关也抹掉，否则 pi 会把下一个参数当成它的值。
      // 清单写成整串（`{{工具}}`）时它自己就是那整串，抹掉它就够了。
      if (rest[rest.length - 1]?.startsWith('-')) rest.pop()
    } else {
      rest.push(arg)
    }
  }
  return { prompt, keepSession, sessionId, rest }
}

// 提示词有两副面孔：给一份 md 的**路径**（`[[提示词]]` 接文本节点时就是它）就读那份文件；
// 给别的就当**正文本身** —— 一句短提示词直接在框里写上就行，不必为它再摆一个文本节点。
//
// 读不到的时候要不要报错，看它「像不像一个路径」。判据是**整串就是一个路径的样子**：没有空白、
// 不是网址。只要带一个空格就不算 —— 否则提示词里出现一个反斜杠（`printf 'a\r\n'`、
// `C:\projects\x`）就会被当成「路径读不到」而停下来，那句错话比真错还难查。
// 看着像路径却读不到，还是报错：别把路径本身当成提示词送给 pi。
const looksLikePath = (value) =>
  !/\s/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && (/[\\/]/.test(value) || /\.(md|markdown|txt)$/i.test(value))
async function readPrompt(value) {
  const file = await fs.readFile(value, 'utf8').catch(() => null)
  if (file !== null) return file
  return looksLikePath(value) ? null : value
}

// ---- 事件流翻成人话 ----

// 工具调用只报「哪个工具、拿什么参数」：参数里挑最像「它在干什么」的那一个。
const ARG_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name']
function describeCall(name, args = {}) {
  const key = ARG_KEYS.find((item) => typeof args[item] === 'string' && args[item].trim())
  // 认不出参数名就退一步：这个工具传进来的第一个字符串
  const value = String(key ? args[key] : Object.values(args).find((item) => typeof item === 'string') ?? '')
  const text = value.trim().replace(/\s+/g, ' ')
  return text ? `${name} ${text.length > 120 ? `${text.slice(0, 120)}…` : text}` : name
}

// 工具跑完的收成：几行、头一行说什么。几万行的 bash 输出也只留一行摘要。
// 行尾的 \r 得先摘掉：命令输出常常是 CRLF，留着的话摘要后面那截会被顶到下一行去。
function describeResult(result) {
  const text = (result?.content ?? []).map((part) => part?.text ?? '').join('').replace(/\r\n?/g, '\n').trim()
  if (!text) return '没有输出'
  const rows = text.split('\n')
  const head = rows[0].length > 100 ? `${rows[0].slice(0, 100)}…` : rows[0]
  return rows.length > 1 ? `${head}（共 ${rows.length} 行）` : head
}

// 一条事件 → 一行诊断。时间栏说「第几秒发生的」，动作行尾再说「这一下花了多久」——
// 两者一合，正文上就分得清哪一步慢、哪一段是模型在想、哪儿是真空了。
// 回话原样过（它本来就是给人读的），思考只报长短 —— 那是模型的草稿纸，铺满正文反而把动作挤没了。
function trace(event, state) {
  switch (event.type) {
    case 'session':
      line(`· 起于 ${event.cwd}`, 0)
      break
    case 'turn_start':
      state.turns += 1
      line(`─ 第 ${state.turns} 轮`)
      break
    case 'message_update': {
      const inner = event.assistantMessageEvent ?? {}
      if (inner.type === 'text_delta') emit(inner.delta ?? '')
      else if (inner.type === 'thinking_start') state.thinkAt = since()
      else if (inner.type === 'toolcall_end' && inner.toolCall) {
        state.tools += 1
        line(`→ ${describeCall(inner.toolCall.name, inner.toolCall.arguments)}`)
        act(inner.toolCall.name, inner.toolCall.arguments)
      } else if (inner.type === 'thinking_end') line(`… 想了想（${(inner.content ?? '').length} 字）${spentOf(state.thinkAt)}`)
      break
    }
    case 'tool_execution_start':
      state.toolAt.set(event.toolCallId, since())
      break
    case 'tool_execution_end': {
      const spent = spentOf(state.toolAt.get(event.toolCallId))
      if (state.toolAt.has(event.toolCallId)) state.toolMs += since() - state.toolAt.get(event.toolCallId)
      line(`← ${event.toolName} ${describeResult(event.result)}${spent}${event.isError ? ' ✗' : ''}`)
      break
    }
    case 'message_end':
      // 只有真说了话才算回话：调工具那一轮里 assistant 也发消息，但正文是空的
      if (event.message?.role === 'assistant') {
        const said = textOf(event.message)
        if (said.trim()) state.answer = said
      }
      break
  }
}

// 「这一步花了多久」：没记到起点就不说话，宁可少一个数也别编一个。
function spentOf(from) {
  return from === undefined ? '' : ` · ${((since() - from) / 1000).toFixed(1)}s`
}

// 一条消息的正文（assistant 的是分块的，system 的那一坨是整串）
const textOf = (message) => (Array.isArray(message.content)
  ? message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
  : String(message.content ?? ''))

// --mode json 是一行一条 JSON。块边界落在哪儿都可能，所以攒到换行才切。
function makeReader(onLine) {
  let buffer = ''
  return {
    push(text) {
      buffer += text
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (raw.trim()) onLine(raw)
      }
    },
    flush() {
      if (buffer.trim()) onLine(buffer)
      buffer = ''
    },
  }
}

// 跑 pi：stdout 是事件流，stderr 原样转进诊断。跑完把退出码交回来，回话攒在 state 里。
const runPi = (args, input, cwd, state) =>
  new Promise((done) => {
    const child = startPi(args, cwd)
    const read = makeReader((raw) => {
      let event = null
      try {
        event = JSON.parse(raw)
      } catch {
        line(raw) // 不是 JSON 的行：pi 自己冒出来的话，原样留给人看
      }
      if (!event) return
      state.lastAt = Date.now()
      trace(event, state)
    })
    child.stdout.on('data', (chunk) => {
      state.lastAt = Date.now()
      read.push(chunk)
    })
    // pi 自己报的错（认证没了、模型名不认识）也走诊断，不混进值里
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
    child.stdin.on('error', () => {}) // pi 没读 stdin 就走了：别让 EPIPE 把脚本带崩
    child.stdin.end(input)
  })

try {
  const { prompt, keepSession, sessionId, rest } = split(process.argv.slice(2))
  if (!prompt) throw new Error('没给 --prompt：节点上的「提示词」还没接上')
  const text = await readPrompt(prompt)
  if (text === null) throw new Error(`提示词读不到：${prompt}`)
  // 体检：漏出来的裸词会落到 pi 的**提示词**上，而且一条排成一条独立的消息。
  // 这不是「跑得不对」，是「跑的是另一件事」—— 所以停在起跑线上，别等它答完两轮才让人起疑。
  // （判定规矩：跟在开关后面的第一个词算那个开关的值，剩下的就是裸词。）
  const strays = straysIn(rest)
  if (strays.length) {
    const list = strays.map((item) => `「${item}」`).join('')
    throw new Error(`${list}不是开关，会被 pi 当成提示词（一条独立的消息）。开关框的写法看扩展的 args 行：带了前缀的（--provider {{提供商}}）只填值 sub2api，整串开关那一栏（{{工具}}）才写 --tools read,bash`)
  }
  // --mode json：说完就退，而且全程有事件可看。stdin 里那份正文就是这一轮的消息，
  // 多长、多少行都无所谓。有会话 id 就钉死那一份（没有就建）；没有 id 才看留会话。
  const args = ['--mode', 'json', ...rest]
  if (sessionId) args.push('--session-id', sessionId)
  else if (!keepSession) args.push('--no-session')
  const state = { lastAt: Date.now(), turns: 0, tools: 0, answer: '', err: '', toolAt: new Map(), toolMs: 0, thinkAt: undefined }
  // 卡住得看得出来：二十分钟没动静和「正在想」在画布上一模一样，所以静下来就把等了多久写出来
  const beat = setInterval(() => {
    const idle = Math.round((Date.now() - state.lastAt) / 1000)
    if (idle >= 20) line(`… 已经 ${idle}s 没有新动静`)
  }, 20000)
  const record = await runPi(args, text, process.cwd(), state)
  clearInterval(beat)
  if (record.error) throw new Error(`pi 起不来：${record.error.message}`)
  // 总时长拆成两半：工具在跑的，和模型在想/在写的。心里有数才知道下次该调哪个。
  const spent = since() / 1000
  const tools = state.toolMs / 1000
  line(`· pi 退出码 ${record.code} · ${state.turns} 轮 · ${state.tools} 个工具 · ${spent.toFixed(1)}s（工具 ${tools.toFixed(1)}s / 模型 ${(spent - tools).toFixed(1)}s）`)
  const answer = state.answer.trim()
  if (record.code !== 0) {
    const why = state.err.trim() || answer || '没有输出'
    say({ ok: false, reason: `pi 退出码 ${record.code}：${why.slice(0, 300)}` })
    process.exitCode = record.code
  } else if (!answer) {
    say({ ok: false, reason: 'pi 没有回话' })
  } else {
    const payload = { ok: true, text: answer }
    const inner = parseObject(answer)
    if (inner) {
      for (const [key, value] of Object.entries(inner)) {
        if (key === 'ok') continue
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') payload[key] = value
      }
    }
    say(payload)
  }
} catch (error) {
  line(`✗ ${error.message}`) // 没跑成的原因也要落在节点正文上，别只在值里
  say({ ok: false, reason: error.message })
  process.exitCode = 1
}
