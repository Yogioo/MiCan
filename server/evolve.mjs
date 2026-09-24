// 进化：按固定顺序跑一遍「停链 → 快照 → 诊断 → pi 改工作文件夹 → 校验 → commit + push」（docs/ai-evolution.md）。
// 进化期间不跑链：在跑的先停掉，新的不让起（runner），定时器到点跳过（scheduler），前端的落盘不收（api save）。
// 做完前端从盘上重开一遍。诊断和 pi 用的是内置库里那两份，不要求工作文件夹里拷过。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dataInto, findNode } from '../src/core/graph.mjs'
import { CACHE_DIR, CANVAS_FILE, DOCS_DIR } from '../src/core/paths.mjs'
import { pickValue } from '../src/core/pick.mjs'
import { deserialize } from '../src/core/serialize.mjs'
import { applyVars } from '../src/core/vars.mjs'
import { startCommand } from './exec.mjs'
import { EXT_DIR, LIBRARY_ROOT, commandOf } from './extensions.mjs'

// 进化能动的三层（ITERATE.md）：快照、回滚、commit 都只圈这几处，.mican/ 里的运行产物不跟着卷。
const LAYERS = [CANVAS_FILE, DOCS_DIR, EXT_DIR]
const EVOLVE_DIR = `${CACHE_DIR}/evolve`
// 校验不过，把原因交回 pi 再改：总共最多几次
const MAX_TRIES = 3

const DIAGNOSE = path.join(LIBRARY_ROOT, EXT_DIR, 'diagnose', 'run.mjs')
const PI = path.join(LIBRARY_ROOT, EXT_DIR, 'pi', 'run.mjs')

const quote = (value) => `"${value}"`

function git(root, args) {
  return new Promise((done) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => done({ code: 1, out: '', err: error.message }))
    child.on('close', (code) => done({ code, out: out.trim(), err: err.trim() }))
  })
}

async function mustGit(root, args) {
  const result = await git(root, args)
  if (result.code !== 0) throw new Error(`git ${args[0]} 失败：${result.err || result.out || `退出码 ${result.code}`}`)
  return result.out
}

// pathspec 对不上任何文件 git 会报错：只交盘上有的、或索引里记着的（被删掉的也要算进去）
async function layersOf(root) {
  const found = []
  for (const item of LAYERS) {
    if (existsSync(path.join(root, item)) || (await git(root, ['ls-files', '--', item])).out) found.push(item)
  }
  return found
}

async function snapshot(root) {
  const layers = await layersOf(root)
  if (layers.length) await mustGit(root, ['add', '-A', '--', ...layers])
  const changed = layers.length && (await git(root, ['diff', '--cached', '--quiet', '--', ...layers])).code !== 0
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
  if (changed) await mustGit(root, ['commit', '-q', '-m', '进化前快照', '--', ...layers])
  else if (!hasHead) await mustGit(root, ['commit', '-q', '--allow-empty', '-m', '进化前快照'])
  return mustGit(root, ['rev-parse', 'HEAD'])
}

// 回到快照：三层里改过的还原、新冒出来的删掉
async function rollback(root, sha) {
  const tracked = (await git(root, ['ls-tree', '--name-only', sha, '--', ...LAYERS])).out.split('\n').filter(Boolean)
  const layers = await layersOf(root)
  if (layers.length) await git(root, ['reset', '-q', '--', ...layers])
  if (tracked.length) await mustGit(root, ['restore', `--source=${sha}`, '--staged', '--worktree', '--', ...tracked])
  const extra = LAYERS.filter((item) => existsSync(path.join(root, item)))
  if (extra.length) await git(root, ['clean', '-fdq', '--', ...extra])
}

// 跑一段脚本，拿 stdout 那段 JSON。stdout 不是 JSON 就当失败。
async function runScript(command, { cwd, settings, onLog }) {
  const child = startCommand({
    command,
    cwd,
    shell: settings.shell,
    timeout: settings.timeout,
    outputLimit: settings.outputLimitKb * 1024,
    onChunk: (text, stream) => { if (stream === 'log') onLog?.(text) },
  })
  const record = await child.done
  let data = null
  try {
    data = JSON.parse(record.output.trim())
  } catch {}
  return { ...record, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null }
}

function promptOf({ hint, diagnosis, failure }) {
  const { text = '', ...facts } = diagnosis ?? {}
  return [
    '你在迭代一份 MiCan 工作文件夹，就是当前目录。有 ITERATE.md 就先读它，照它改；用语对不上看 CONTEXT.md。',
    '',
    '## 这次要解决的',
    hint || '用户没写，照下面的诊断改。',
    '',
    '## 运行历史的诊断',
    diagnosis ? text : '还没有运行历史。',
    ...(diagnosis ? ['', '```json', JSON.stringify(facts, null, 2), '```'] : []),
    '',
    '## 规矩',
    `- 只改 ${CANVAS_FILE}、${DOCS_DIR}/、${EXT_DIR}/ 三处，别碰 ${CACHE_DIR}/。`,
    `- 文本节点的正文改 ${DOCS_DIR}/ 里那份 md；${CANVAS_FILE} 里的 text 改完会按 md 覆盖。`,
    '- 方向是把 agent 每次都在重复做的动作收进脚本（新写一个扩展接进链），并从提示词里删掉让 agent 自己去做的那几句；agent 只留真要判断的那一步。',
    `- 新节点的 id 别跟已有的重，x / y / w / h 摆在上游旁边；别动 view 和 results。`,
    '- 没什么该改的就不改。',
    '- 最后用一两句话说你改了什么、为什么：这段话就是这次 commit 的说明。',
    ...(failure ? ['', '## 上一次没过校验', failure, '', '上一次的改动已经回滚，重新改。'] : []),
  ].join('\n')
}

// 文本节点的正文以 md 为准：pi 改的是 md，存档里的 text 跟着它走。md 没了就是校验不过。
async function syncTexts(root, data) {
  const problems = []
  for (const node of data.nodes ?? []) {
    if (node.kind !== 'text') continue
    const text = await fs.readFile(path.join(root, node.file), 'utf8').catch(() => null)
    if (text === null) problems.push(`文本节点 ${node.id} 的 ${node.file} 不在了`)
    else node.text = text
  }
  if (!problems.length) await fs.writeFile(path.join(root, CANVAS_FILE), JSON.stringify(data, null, 2), 'utf8')
  return problems
}

// 校验只管「改完这条链还跑不跑得起来」，全是机械检查。返回攒下来的问题，空就是过了。
async function validate(root, sha, { settings, onLog }) {
  let data
  try {
    data = JSON.parse(await fs.readFile(path.join(root, CANVAS_FILE), 'utf8'))
  } catch (error) {
    return [`${CANVAS_FILE} 解析不了：${error.message}`]
  }
  let graph
  try {
    graph = deserialize(data).graph
  } catch (error) {
    return [`${CANVAS_FILE} 结构不对：${error.message}`]
  }
  const ids = new Set(data.nodes.map((node) => node?.id))
  const problems = data.edges.filter((edge) => !ids.has(edge?.from) || !ids.has(edge?.to)).map((edge) => `边 ${edge?.id} 有一头的节点不在`)
  problems.push(...(await syncTexts(root, data)))
  if (problems.length) return problems
  graph = deserialize(data).graph

  // 下游取法对得上改完的正文：提取节点的源是文本节点时，照它的取法取一遍
  for (const node of graph.nodes) {
    if (node.kind !== 'extract') continue
    const source = findNode(graph, dataInto(graph, node.id)[0]?.from)
    if (source?.kind !== 'text') continue
    const picked = pickValue(source.text, node.pick ?? '', { multiline: true })
    if (picked.error) problems.push(`提取节点 ${node.id} 从 ${source.file} 取不到「${node.pick}」：${picked.error}`)
  }

  const fresh = new Set()
  for (const node of graph.nodes) {
    if (!node.extension) continue
    try {
      const built = await commandOf(root, node.extension)
      if (!existsSync(built.entry)) throw new Error(`entry 指的文件不在：${built.entry}`)
      const known = await git(root, ['cat-file', '-e', `${sha}:./${node.extension}/EXTENSION.md`])
      if (known.code !== 0) fresh.add(node.extension)
    } catch (error) {
      problems.push(`节点 ${node.id} 引用的扩展 ${node.extension}：${error.message}`)
    }
  }
  if (problems.length) return problems

  // 新扩展接进链之前单独跑一次：输入只给清单里的默认值，stdout 得是一段 JSON，没报失败时声明的出口都得有值
  for (const rel of fresh) {
    const built = await commandOf(root, rel)
    const vars = new Map(Object.entries(built.defaults ?? {}).map(([name, value]) => [name, { text: value, file: value, typed: true }]))
    const { command } = applyVars(built.command, vars)
    onLog?.(`\n· 试跑新扩展 ${rel}\n`)
    const result = await runScript(command, { cwd: root, settings, onLog })
    if (!result.data) {
      problems.push(`新扩展 ${rel} 试跑时 stdout 不是一段 JSON：${result.output.trim().slice(0, 200) || '没有输出'}`)
      continue
    }
    if (result.data.ok === false) continue
    for (const [name, spec] of Object.entries(built.outputs ?? {})) {
      const picked = pickValue(result.output, spec, { multiline: true })
      if (picked.error || picked.missing) problems.push(`新扩展 ${rel} 试跑时出口「${name}」取不到值`)
    }
  }
  return problems
}

export function createEvolver({ getRoot, readSettings, stopRuns, afterward }) {
  let current = null
  let last = null
  // 最近这一次的过程：进化窗口按偏移量来取新增的那段
  let log = { id: 0, text: '' }

  const status = () => ({ active: Boolean(current), phase: current?.phase ?? '', startedAt: current?.startedAt ?? null, logId: log.id, last })
  const readLog = (id, from = 0) => (id === log.id ? log.text.slice(from) : log.text)

  async function evolve(root, hint) {
    const at = current.startedAt
    const settings = await readSettings()
    const dir = path.join(root, EVOLVE_DIR)
    await fs.mkdir(dir, { recursive: true })
    const logFile = path.join(dir, `${at}.log`)
    const onLog = (text) => {
      log.text += text
      return fs.appendFile(logFile, text, 'utf8').catch(() => {})
    }
    const phase = (text) => {
      current.phase = text
      onLog(`\n· ${text}\n`)
    }

    phase('停下在跑的链')
    await stopRuns()

    phase('诊断')
    const diag = await runScript(`node ${quote(DIAGNOSE)} --root ${quote(root)}`, { cwd: root, settings, onLog })
    if (!diag.data) throw new Error(`诊断没跑成：${diag.log.trim().slice(-200) || '没有输出'}`)
    if (diag.data.ok === false && !hint) return { ok: false, message: `没进化：${diag.data.reason}` }
    const diagnosis = diag.data.ok === false ? null : diag.data

    phase('快照')
    const sha = await snapshot(root)
    try {
      return await change(root, { at, hint, diagnosis, sha, settings, dir, phase, onLog })
    } catch (error) {
      await rollback(root, sha).catch(() => {})
      throw error
    }
  }

  async function change(root, { at, hint, diagnosis, sha, settings, dir, phase, onLog }) {
    const flags = ['--留会话', 'false']
    if (settings.evolveProvider) flags.push('--provider', quote(settings.evolveProvider))
    if (settings.evolveModel) flags.push('--model', quote(settings.evolveModel))
    const promptFile = path.join(dir, `${at}-prompt.md`)
    let failure = ''
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      phase(`pi 第 ${attempt} 次`)
      await fs.writeFile(promptFile, promptOf({ hint, diagnosis, failure }), 'utf8')
      const pi = await runScript(`node ${quote(PI)} --prompt ${quote(promptFile)} ${flags.join(' ')}`, { cwd: root, settings, onLog })
      if (!pi.data?.ok) {
        await rollback(root, sha)
        return { ok: false, message: `pi 没做成：${pi.data?.reason ?? '没有输出'}` }
      }

      phase('校验')
      const problems = await validate(root, sha, { settings, onLog })
      if (problems.length) {
        failure = problems.map((item) => `- ${item}`).join('\n')
        onLog(`${failure}\n`)
        await rollback(root, sha)
        continue
      }

      phase('存档')
      const layers = await layersOf(root)
      if (layers.length) await mustGit(root, ['add', '-A', '--', ...layers])
      if (!layers.length || (await git(root, ['diff', '--cached', '--quiet', '--', ...layers])).code === 0) {
        return { ok: true, message: `pi 看过了，没改：${pi.data.text.trim().split('\n')[0]}` }
      }
      const said = pi.data.text.trim()
      const message = [`进化：${said.split('\n')[0]}`, '', said, ...(hint ? ['', `进化提示词：${hint}`] : [])].join('\n')
      await mustGit(root, ['commit', '-q', '-m', message, '--', ...layers])
      const commit = await mustGit(root, ['rev-parse', '--short', 'HEAD'])
      const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0
      const pushed = upstream ? await git(root, ['push', '-q']) : null
      const note = !upstream ? '（没有上游分支，没 push）' : pushed.code ? `（push 失败：${pushed.err || pushed.out}）` : ''
      return { ok: true, commit, message: `已进化 ${commit}：${said.split('\n')[0]}${note}` }
    }
    return { ok: false, message: `校验 ${MAX_TRIES} 次都没过，已回滚：\n${failure}` }
  }

  async function start({ hint = '' } = {}) {
    const root = getRoot()
    if (!root) throw new Error('先打开一个工作文件夹')
    if (current) throw new Error('已经在进化了，等它做完')
    const inside = await git(root, ['rev-parse', '--show-toplevel'])
    if (inside.code !== 0) throw new Error('这个工作文件夹不是 git 仓库：先在里面 git init 并提交一次，进化才有快照可回滚')
    current = { startedAt: Date.now(), phase: '' }
    log = { id: current.startedAt, text: '' }
    evolve(root, String(hint).trim())
      .catch((error) => ({ ok: false, message: `进化出错了：${error.message}` }))
      .then(async (result) => {
        log.text += `\n· ${result.message}\n`
        last = { at: Date.now(), ...result }
        current = null
        await afterward()
      })
    return status()
  }

  return { start, status, readLog, active: () => Boolean(current) }
}
