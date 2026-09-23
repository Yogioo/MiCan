// pi：在运行目录里让 pi 干一件事，把它的回话包成一段 JSON（见 EXTENSION.md）。
//
// 自己只认两个参数，其余**原样转给 pi**：
//   `--prompt <md 路径 | 正文>`   提示词。长的那样给路径（多行的进不了命令行）；短的直接把字写在这儿就行。
//   `--留会话 <true|false>`  留就什么都不加，不留就补上 `--no-session`。
//
// 「原样转给 pi」的意思是：节点上那六个开关框里写什么，pi 就收到什么（`--model sonnet`、
// `--tools read,bash`、`--no-skills`……）。唯一的保留词是 `空`（清单里每个开关的默认值）：
// 这一个开关一个参数都不加，把它滤掉。所以加开关只用改 EXTENSION.md，不用改这个文件。
//
// stdout 就是节点的值：永远吐一段合法 JSON，兜不住也吐 {"ok":false,...}，不让它漏到链上。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'

// 开关框里写它 = 这个开关不加任何参数（见 EXTENSION.md）。
const NO_FLAG = '空'
// 自己认的另一个名字：留会话，true / false。
const KEEP_SESSION = '--留会话'
const IS_WINDOWS = process.platform === 'win32'
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

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
  const line = ['pi', ...args].map(quote).join(' ')
  return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd, windowsVerbatimArguments: true })
}

// argv 里 --prompt / --留会话 归自己，`空` 滤掉，其余一个不动地留给 pi。
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
      // 布尔就认这两个词：写错了宁可停下来，也别猜它想要什么
      if (value !== 'true' && value !== 'false') throw new Error(`${KEEP_SESSION} 只认 true / false，收到「${value}」`)
      keepSession = value === 'true'
      i += 1
    } else if (arg !== NO_FLAG) rest.push(arg)
  }
  return { prompt, keepSession, rest }
}

// 提示词有两副面孔：给一份 md 的**路径**（`[[提示词]]` 接文本节点时就是它）就读那份文件；
// 给别的就当**正文本身** —— 一句短提示词直接在框里写上就行，不必为它再摆一个文本节点。
// 看着像路径（带分隔符、或像个 .md）却读不到，还是报错：别把路径本身当成提示词送给 pi。
const looksLikePath = (value) => /[\\/]/.test(value) || /\.(md|markdown|txt)$/i.test(value)
async function readPrompt(value) {
  const file = await fs.readFile(value, 'utf8').catch(() => null)
  if (file !== null) return file
  return looksLikePath(value) ? null : value
}

// 跑完把三样东西一起交回来；起不来（pi 没装之类）走 error 那条。
const runPi = (args, input, cwd) =>
  new Promise((done) => {
    const child = startPi(args, cwd)
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => done({ error }))
    child.on('close', (code) => done({ code: typeof code === 'number' ? code : 1, out, err }))
    child.stdin.on('error', () => {}) // pi 没读 stdin 就走了：别让 EPIPE 把脚本带崩
    child.stdin.end(input)
  })

try {
  const { prompt, keepSession, rest } = split(process.argv.slice(2))
  if (!prompt) throw new Error('没给 --prompt：节点上的「提示词」还没接上')
  const text = await readPrompt(prompt)
  if (text === null) throw new Error(`提示词读不到：${prompt}`)
  // -p：说完就退。stdin 里那份正文就是 pi 的初始消息，多长、多少行都无所谓。
  // 留会话才不加 --no-session —— 默认不留：链会重跑，会话文件只会一路涨。
  const args = ['-p', ...rest]
  if (!keepSession) args.push('--no-session')
  const record = await runPi(args, text, process.cwd())
  if (record.error) throw new Error(`pi 起不来：${record.error.message}`)
  const answer = record.out.trim()
  if (record.code !== 0) {
    const why = record.err.trim() || answer || '没有输出'
    say({ ok: false, reason: `pi 退出码 ${record.code}：${why.slice(0, 300)}` })
    process.exitCode = record.code
  } else if (!answer) {
    say({ ok: false, reason: 'pi 没有回话' })
  } else {
    say({ ok: true, text: answer })
  }
} catch (error) {
  say({ ok: false, reason: error.message })
  process.exitCode = 1
}
