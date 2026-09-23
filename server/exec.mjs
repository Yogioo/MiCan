// 跑一条命令的唯一实现：链的运行器走这里，别在别处再 spawn 一次。
// 命令行怎么起、输出怎么解码、怎么把整棵进程树收掉，都在这一个文件里。
// stdout 与 stderr 是两回事：前者是节点给出去的值，后者是给人看的诊断。
import { spawn } from 'node:child_process'

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

// 界面上的下拉要摆哪几个名字 —— 认哪些名字是这儿的事。
export const shellNames = () => Object.keys(SHELLS)

// 空串 = 跟这台机器的默认（Windows 上 cmd，其余 sh）
export function shellOf(name, command) {
  const wanted = String(name ?? '').trim().toLowerCase()
  const build = SHELLS[wanted || (IS_WINDOWS ? 'cmd' : 'sh')]
  if (!build) throw new Error(`不认识的行命令行：${name}（可填 ${shellNames().join(' / ')}）`)
  return build(command)
}

// 逐块解码：UTF-8 优先，块里出现替换字符时按 GBK 重来（cmd 内建消息走的是 OEM 代码页）。
// stream: true 会把块尾截断的多字节字符留到下一块，不会被当成坏编码。
export function createDecoder() {
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

function killTree(child) {
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

// 起一条命令，返回 { done, stop }：done 是它跑完的 Promise，stop 掐掉整棵进程树。
// onChunk 收增量输出（只为显示用，正文由这里自己攒）。
//
// **两条流走两条路**：stdout 是节点的值（进缓存文件、顺着数据边往下走），stderr 是诊断
// （只在节点上显示、跑完存成 .log 边车文件）。所以扩展可以拿 stderr 吐人话的进度，
// 值那一头照样是一段干净 JSON —— 见 docs/extension-contract.md 的输出契约。
//
// 超时和输出上限都在这儿管：超时掐进程；超上限只截断、不杀进程 —— 杀掉等于把 agent 的活白干了。
// 上限是两条流合起来算的，一条话痨的诊断流别想把内存撑爆。
// 命令读 stdin 的（如 pi -p）靠 stdin.end() 拿 EOF，否则会一直挂到超时。
export function startCommand({ command, cwd, shell, timeout, outputLimit, onChunk }) {
  const launch = shellOf(shell, command) // 名字不认识就抛，调用方去报错
  const child = spawn(launch.file, launch.args, { cwd, windowsHide: true, windowsVerbatimArguments: launch.verbatim })
  child.stdin.end()

  const decode = createDecoder()
  let output = ''
  let log = ''
  let bytes = 0
  let code = 1
  let truncated = false
  let timedOut = false
  let stopped = false
  let settled = false

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, timeout * 1000)

  // kind：'out' 是值，'log' 是诊断。两条流共用一份字节预算，超了就一起截断。
  function sink(kind) {
    return (chunk) => {
      if (truncated) return
      const room = outputLimit - bytes
      bytes += chunk.length
      if (chunk.length > room) truncated = true
      const text = decode(chunk.subarray(0, Math.max(room, 0)))
      if (!text) return
      if (kind === 'log') log += text
      else output += text
      onChunk?.(text, kind)
    }
  }
  child.stdout.on('data', sink('out'))
  child.stderr.on('data', sink('log'))

  const done = new Promise((resolve) => {
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, failed: code !== 0 || timedOut || truncated || stopped, timedOut, truncated, stopped, output, log })
    }
    // 起不来（命令行不存在之类）：当成退出码 1，错误写进诊断 —— 那是「为什么没跑成」，不是值
    child.on('error', (error) => {
      log += error.message
      finish()
    })
    child.on('close', (value) => {
      code = typeof value === 'number' ? value : 1
      finish()
    })
  })

  return {
    done,
    stop() {
      if (settled) return
      stopped = true
      killTree(child)
    },
  }
}
