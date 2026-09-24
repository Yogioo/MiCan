// 进化：按固定顺序跑一遍「停链 → 快照 → 诊断 → pi 改工作文件夹 → 校验 → commit + push」（docs/ai-evolution.md）。
// 进化期间不跑链：在跑的先停掉，新的不让起（runner），定时器到点跳过（scheduler），前端的落盘不收（api save）。
// 做完前端从盘上重开一遍。诊断和 pi 用的是内置库里那两份，不要求工作文件夹里拷过。
// 自动触发、进化记录、撤销见 ADR-0024。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dataInto, findNode } from '../src/core/graph.mjs'
import { CACHE_DIR, CANVAS_FILE, DOCS_DIR, LAYOUT_FILE, RUNS_FILE } from '../src/core/paths.mjs'
import { pickValue } from '../src/core/pick.mjs'
import { nextFireAt, parseSchedule } from '../src/core/schedule.mjs'
import { FORMAT_VERSION, deserialize } from '../src/core/serialize.mjs'
import { applyVars } from '../src/core/vars.mjs'
import { startCommand } from './exec.mjs'
import { EXT_DIR, LIBRARY_ROOT, commandOf } from './extensions.mjs'

// 快照、回滚、commit 都只圈这几处，.mican/ 里的运行产物不跟着卷。
// pi 只改三层（ITERATE.md）；布局也圈进来，回滚、撤销时用户摆的位置跟着节点一起回来（ADR-0023）。
const LAYERS = [CANVAS_FILE, LAYOUT_FILE, DOCS_DIR, EXT_DIR]
const EVOLVE_DIR = `${CACHE_DIR}/evolve`
// 配置和记录跟工作文件夹走，但不在 pi 能改的三层里：放 mican.json 它就能把自己的触发条件改掉
const CONFIG_FILE = `${EVOLVE_DIR}/config.json`
const HISTORY_FILE = `${EVOLVE_DIR}/history.jsonl`
// 校验不过，把原因交回 pi 再改：总共最多几次
const MAX_TRIES = 3
// 提示词里给 pi 看的最近 commit 条数
const RECENT_COMMITS = 20
const MAX_DELAY_MS = 2 ** 31 - 1

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

// 算改没改、commit 的时候还要带上只在 HEAD 里的：revert 删掉整个目录时，索引和盘上都已经没有它了
async function committedLayersOf(root) {
  const found = []
  for (const item of LAYERS) {
    if (existsSync(path.join(root, item)) || (await git(root, ['ls-files', '--', item])).out || (await git(root, ['ls-tree', '--name-only', 'HEAD', '--', item])).out) found.push(item)
  }
  return found
}

async function snapshot(root) {
  const layers = await layersOf(root)
  if (layers.length) await mustGit(root, ['add', '-A', '--', ...layers])
  const changed = layers.length && (await git(root, ['diff', '--cached', '--quiet', '--', ...layers])).code !== 0
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
  // 收的是用户上次进化以来在画布上的手改：pi 看历史时要认得出来
  if (changed) await mustGit(root, ['commit', '-q', '-m', '进化前快照（用户改动）', '--', ...layers])
  else if (!hasHead) await mustGit(root, ['commit', '-q', '--allow-empty', '-m', '进化前快照（用户改动）'])
  return mustGit(root, ['rev-parse', 'HEAD'])
}

// 三层整份回到某个 commit：改过的还原，那时没有的删掉（新冒出来的、之后才 commit 进来的都算）
async function rollback(root, sha) {
  const tracked = (await git(root, ['ls-tree', '--name-only', sha, '--', ...LAYERS])).out.split('\n').filter(Boolean)
  const layers = await layersOf(root)
  if (layers.length) await git(root, ['rm', '-rq', '--cached', '--ignore-unmatch', '--', ...layers])
  if (tracked.length) await mustGit(root, ['restore', `--source=${sha}`, '--staged', '--worktree', '--', ...tracked])
  const extra = LAYERS.filter((item) => existsSync(path.join(root, item)))
  if (extra.length) await git(root, ['clean', '-fdq', '--', ...extra])
}

// 三层有改动就 commit，有上游就 push。没改动返回 null。
async function commitLayers(root, message) {
  const present = await layersOf(root)
  if (present.length) await mustGit(root, ['add', '-A', '--', ...present])
  const layers = await committedLayersOf(root)
  if (!layers.length || (await git(root, ['diff', '--cached', '--quiet', '--', ...layers])).code === 0) return null
  await mustGit(root, ['commit', '-q', '-m', message, '--', ...layers])
  const commit = await mustGit(root, ['rev-parse', '--short', 'HEAD'])
  const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0
  const pushed = upstream ? await git(root, ['push', '-q']) : null
  const note = !upstream ? '（没有上游分支，没 push）' : pushed.code ? `（push 失败：${pushed.err || pushed.out}）` : ''
  return { commit, note }
}

// 三层最近的 commit：只给说明和改动的文件，要细看 pi 自己 git show
async function recentChanges(root) {
  const layers = await layersOf(root)
  if (!layers.length) return ''
  return (await git(root, ['log', '-n', String(RECENT_COMMITS), '--stat', '--date=format:%Y-%m-%d %H:%M', '--format=%h %ad%n%B', '--', ...layers])).out
}

const readLines = (text) =>
  text.split(/\r?\n/).flatMap((row) => {
    if (!row.trim()) return []
    try {
      return [JSON.parse(row)]
    } catch {
      return []
    }
  })

// 自动进化的配置：哪项不填就不看哪项。写进来的值不对就报错，让用户重填。
export function checkConfig(input = {}) {
  const config = { auto: input.auto === true }
  for (const [key, what] of [['runs', '攒够多少次运行'], ['streak', '连败多少次']]) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    const count = Math.round(Number(value))
    if (!Number.isFinite(count) || count < 1) throw new Error(`${what}得是大于 0 的整数：${value}`)
    config[key] = count
  }
  const daily = String(input.daily ?? '').trim()
  if (daily) {
    const schedule = parseSchedule(daily)
    if (schedule?.mode !== 'daily') throw new Error(`每天几点得写成 HH:MM：${daily}`)
    config.daily = schedule.at
  }
  return config
}

async function readConfig(root) {
  try {
    return checkConfig(JSON.parse(await fs.readFile(path.join(root, CONFIG_FILE), 'utf8')))
  } catch {
    return { auto: false } // 没设过、或存坏了，都当没开
  }
}

async function readHistory(root) {
  return readLines(await fs.readFile(path.join(root, HISTORY_FILE), 'utf8').catch(() => ''))
}

// 上次进化之后（以最近一条记录的时刻为界，不管成没成）攒下的运行，看够不够触发
async function triggerOf(root, config, node) {
  const since = (await readHistory(root)).at(-1)?.at ?? 0
  const rows = readLines(await fs.readFile(path.join(root, RUNS_FILE), 'utf8').catch(() => '')).filter((row) => row.at > since)
  if (config.streak && node) {
    let streak = 0
    for (const row of rows.filter((item) => item.node === node).reverse()) {
      if (!row.failed) break
      streak += 1
    }
    if (streak >= config.streak) return 'streak'
  }
  if (config.runs && rows.length >= config.runs) return 'runs'
  return ''
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

function promptOf({ hint, diagnosis, recent, failure }) {
  const { text = '', ...facts } = diagnosis ?? {}
  return [
    '你在迭代一份 MiCan 工作文件夹，就是当前目录。有 ITERATE.md 就先读它，照它改；用语对不上看 CONTEXT.md。',
    '',
    '## 这次要解决的',
    hint || '用户没写，照下面的诊断改。',
    '',
    '## 运行历史的诊断',
    diagnosis ? text : '还没有运行历史。',
    ...(facts.nodes?.some((item) => item.worse)
      ? ['', '标了 worse 的节点是上次改动之后才变差的，先看上次改的是不是原因，是就改回来。']
      : []),
    ...(diagnosis ? ['', '```json', JSON.stringify(facts, null, 2), '```'] : []),
    '',
    '## 最近的改动',
    `${CANVAS_FILE}、${DOCS_DIR}/、${EXT_DIR}/ 最近 ${RECENT_COMMITS} 条 commit，要细看用 git show。`,
    '「进化：」是以前的进化，「进化前快照（用户改动）」是用户的手改，「撤销进化」「还原到进化 … 之前」是用户撤掉的进化（带着撤销理由）。',
    '被撤销过的改法，除非这次有明确不同的理由，别再做。',
    '',
    '```',
    recent || '（还没有）',
    '```',
    '',
    '## 规矩',
    `- 只改 ${CANVAS_FILE}、${DOCS_DIR}/、${EXT_DIR}/ 三处，别碰 ${LAYOUT_FILE} 和 ${CACHE_DIR}/。`,
    `- 文本节点的正文只在 ${DOCS_DIR}/ 里那份 md。`,
    '- 方向是把 agent 每次都在重复做的动作收进脚本（新写一个扩展接进链），并从提示词里删掉让 agent 自己去做的那几句；agent 只留真要判断的那一步。',
    `- 节点靠 name 找，边写的是 id。新节点给一个画布内唯一的 name，id 别跟已有的重。`,
    '- 没什么该改的就不改。',
    '- 最后用一两句话说你改了什么、为什么：这段话就是这次 commit 的说明。',
    ...(failure ? ['', '## 上一次没过校验', failure, '', '上一次的改动已经回滚，重新改。'] : []),
  ].join('\n')
}

// 校验只管「改完这条链还跑不跑得起来」，全是机械检查。返回攒下来的问题，空就是过了。
async function validate(root, sha, { settings, onLog }) {
  let data
  try {
    data = JSON.parse(await fs.readFile(path.join(root, CANVAS_FILE), 'utf8'))
  } catch (error) {
    return [`${CANVAS_FILE} 解析不了：${error.message}`]
  }
  if (data?.version !== FORMAT_VERSION) return [`${CANVAS_FILE} 的 version 得是 ${FORMAT_VERSION}`]
  // 文本节点的正文只在 md：md 没了就是校验不过
  const texts = {}
  const problems = []
  for (const node of Array.isArray(data.nodes) ? data.nodes : []) {
    if (node?.kind !== 'text' || typeof node.file !== 'string') continue
    const text = await fs.readFile(path.join(root, node.file), 'utf8').catch(() => null)
    if (text === null) problems.push(`文本节点 ${node.name || node.id} 的 ${node.file} 不在了`)
    else texts[node.id] = text
  }
  let graph
  try {
    graph = deserialize({ canvas: data, texts }).graph
  } catch (error) {
    return [`${CANVAS_FILE} 结构不对：${error.message}`]
  }
  const ids = new Set(data.nodes.map((node) => node?.id))
  problems.push(...data.edges.filter((edge) => !ids.has(edge?.from) || !ids.has(edge?.to)).map((edge) => `边 ${edge?.id} 有一头的节点不在`))
  if (problems.length) return problems

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

export function createEvolver({ getRoot, readSettings, stopRuns, isIdle, afterward }) {
  let current = null
  let last = null
  // 最近这一次的过程：进化窗口按偏移量来取新增的那段
  let log = { id: 0, text: '' }
  // 自动触发的条件满足了、在等链跑完：{ by, root }
  let pending = null
  let dailyTimer = null

  const status = () => ({ active: Boolean(current), phase: current?.phase ?? '', startedAt: current?.startedAt ?? null, logId: log.id, last })
  const readLog = (id, from = 0) => (id === log.id ? log.text.slice(from) : log.text)

  async function ready() {
    const root = getRoot()
    if (!root) throw new Error('先打开一个工作文件夹')
    if (current) throw new Error('已经在进化了，等它做完')
    const inside = await git(root, ['rev-parse', '--show-toplevel'])
    if (inside.code !== 0) throw new Error('这个工作文件夹不是 git 仓库：先在里面 git init 并提交一次，进化才有快照可回滚')
    if (current) throw new Error('已经在进化了，等它做完')
    return root
  }

  // 进化和撤销都走这一套：只读、滚动显示过程、做完记一行、前端从盘上重开
  function begin(root, { by, hint, verb }, work) {
    const at = Date.now()
    current = { startedAt: at, phase: '' }
    log = { id: at, text: '' }
    const dir = path.join(root, EVOLVE_DIR)
    const ctx = {
      root,
      at,
      hint,
      dir,
      snapshot: '',
      onLog: (text) => {
        log.text += text
        return fs.appendFile(path.join(dir, `${at}.log`), text, 'utf8').catch(() => {})
      },
      phase: (text) => {
        current.phase = text
        ctx.onLog(`\n· ${text}\n`)
      },
    }
    fs.mkdir(dir, { recursive: true })
      .then(() => work(ctx))
      .catch((error) => ({ ok: false, message: `${verb}出错了：${error.message}` }))
      .then(async (result) => {
        log.text += `\n· ${result.message}\n`
        const entry = { at, by, hint, ok: result.ok }
        if (ctx.snapshot) entry.snapshot = ctx.snapshot
        if (result.commit) entry.commit = result.commit
        if (result.target) entry.target = result.target
        if (result.stuck) entry.stuck = true
        Object.assign(entry, { message: result.message, log: `${at}.log` })
        await fs.appendFile(path.join(root, HISTORY_FILE), `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {})
        last = { at: Date.now(), ...result }
        current = null
        await afterward()
        tryPending()
      })
    return status()
  }

  async function start({ hint = '', by = 'manual' } = {}) {
    const root = await ready()
    // 自动触发不带提示词，只照诊断改
    return begin(root, { by, hint: by === 'manual' ? String(hint).trim() : '', verb: '进化' }, evolve)
  }

  async function evolve(ctx) {
    const { root, hint, phase, onLog } = ctx
    const settings = await readSettings()

    phase('停下在跑的链')
    await stopRuns()

    phase('诊断')
    const diag = await runScript(`node ${quote(DIAGNOSE)} --root ${quote(root)}`, { cwd: root, settings, onLog })
    if (!diag.data) throw new Error(`诊断没跑成：${diag.log.trim().slice(-200) || '没有输出'}`)
    if (diag.data.ok === false && !hint) return { ok: false, message: `没进化：${diag.data.reason}` }
    const diagnosis = diag.data.ok === false ? null : diag.data

    phase('快照')
    const sha = await snapshot(root)
    ctx.snapshot = sha
    try {
      return await change(ctx, { diagnosis, sha, settings })
    } catch (error) {
      await rollback(root, sha).catch(() => {})
      throw error
    }
  }

  async function change({ root, at, hint, dir, phase, onLog }, { diagnosis, sha, settings }) {
    const flags = ['--留会话', 'false']
    if (settings.evolveProvider) flags.push('--provider', quote(settings.evolveProvider))
    if (settings.evolveModel) flags.push('--model', quote(settings.evolveModel))
    const promptFile = path.join(dir, `${at}-prompt.md`)
    const recent = await recentChanges(root)
    let failure = ''
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      phase(`pi 第 ${attempt} 次`)
      await fs.writeFile(promptFile, promptOf({ hint, diagnosis, recent, failure }), 'utf8')
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
      const said = pi.data.text.trim()
      const message = [`进化：${said.split('\n')[0]}`, '', said, ...(hint ? ['', `进化提示词：${hint}`] : [])].join('\n')
      const done = await commitLayers(root, message)
      if (!done) return { ok: true, message: `pi 看过了，没改：${said.split('\n')[0]}` }
      return { ok: true, commit: done.commit, message: `已进化 ${done.commit}：${said.split('\n')[0]}${done.note}` }
    }
    return { ok: false, message: `校验 ${MAX_TRIES} 次都没过，已回滚：\n${failure}` }
  }

  // ---- 撤销 ----

  async function entryOf(root, commit) {
    const entry = commit ? (await readHistory(root)).find((item) => item.commit === commit) : null
    if (!entry) throw new Error(`进化记录里没有 ${commit}`)
    return entry
  }

  // 只退那一次，之后的改动留着。撤不了（冲突、校验不过）不交给 pi 解，回到撤之前，让用户选整份还原。
  async function undo({ commit, reason = '' } = {}) {
    const root = await ready()
    const entry = await entryOf(root, commit)
    return begin(root, { by: 'undo', hint: String(reason).trim(), verb: '撤销' }, async (ctx) => {
      const { hint, phase, onLog } = ctx
      const settings = await readSettings()
      phase('停下在跑的链')
      await stopRuns()
      phase('快照')
      const sha = await snapshot(root)
      ctx.snapshot = sha
      const giveUp = async (why) => {
        await rollback(root, sha)
        await git(root, ['revert', '--quit'])
        return { ok: false, target: entry.commit, stuck: true, message: `${entry.commit} 单独撤不了：${why}，已回到撤之前` }
      }
      try {
        phase(`撤销 ${entry.commit}`)
        const reverted = await git(root, ['revert', '--no-commit', entry.commit])
        if (reverted.code !== 0) {
          onLog(`${reverted.err || reverted.out}\n`)
          return await giveUp('后面的改动依赖这一次')
        }
        phase('校验')
        const problems = await validate(root, sha, { settings, onLog })
        if (problems.length) {
          onLog(`${problems.map((item) => `- ${item}`).join('\n')}\n`)
          return await giveUp('撤掉之后校验没过')
        }
        phase('存档')
        const done = await commitLayers(root, [`撤销进化 ${entry.commit}`, ...(hint ? ['', `撤销理由：${hint}`] : [])].join('\n'))
        await git(root, ['revert', '--quit'])
        if (!done) return { ok: true, target: entry.commit, message: `${entry.commit} 的改动已经不在了，没什么可撤` }
        return { ok: true, target: entry.commit, commit: done.commit, message: `已撤销 ${entry.commit}（${done.commit}）${done.note}` }
      } catch (error) {
        await rollback(root, sha).catch(() => {})
        await git(root, ['revert', '--quit'])
        throw error
      }
    })
  }

  // 单独撤不了时的退路：三层按那次进化前的快照整份还原，另起一个 commit。之后的进化和手改一起丢掉。
  async function restore({ commit } = {}) {
    const root = await ready()
    const entry = await entryOf(root, commit)
    if (!entry.snapshot) throw new Error(`${commit} 那次没有快照`)
    return begin(root, { by: 'undo', hint: '', verb: '还原' }, async (ctx) => {
      const { phase } = ctx
      phase('停下在跑的链')
      await stopRuns()
      phase('快照')
      const sha = await snapshot(root)
      ctx.snapshot = sha
      try {
        phase(`还原到 ${entry.commit} 之前`)
        await rollback(root, entry.snapshot)
        phase('存档')
        const done = await commitLayers(root, `还原到进化 ${entry.commit} 之前\n\n按那次进化前的快照 ${entry.snapshot.slice(0, 7)} 整份还原，之后的改动一起丢掉。`)
        if (!done) return { ok: true, target: entry.commit, message: `已经是 ${entry.commit} 之前的样子了` }
        return { ok: true, target: entry.commit, commit: done.commit, message: `已还原到 ${entry.commit} 之前（${done.commit}）${done.note}` }
      } catch (error) {
        await rollback(root, sha).catch(() => {})
        throw error
      }
    })
  }

  // ---- 记录 ----

  async function history() {
    const root = getRoot()
    return { items: root ? await readHistory(root) : [] }
  }

  // 一条记录的细节：commit 说明、改动的文件、那次的过程
  async function record(at) {
    const root = getRoot()
    if (!root) throw new Error('先打开一个工作文件夹')
    const entry = (await readHistory(root)).find((item) => item.at === Number(at))
    if (!entry) throw new Error('没有这条进化记录')
    const show = entry.commit ? (await git(root, ['show', '--stat', '--format=%B', entry.commit])).out : ''
    const text = entry.log ? await fs.readFile(path.join(root, EVOLVE_DIR, path.basename(entry.log)), 'utf8').catch(() => '') : ''
    return { entry, show, log: text }
  }

  // ---- 自动触发 ----

  async function config(patch) {
    const root = getRoot()
    if (!root) throw new Error('先打开一个工作文件夹')
    if (patch === undefined) return readConfig(root)
    const next = checkConfig(patch)
    await fs.mkdir(path.join(root, EVOLVE_DIR), { recursive: true })
    await fs.writeFile(path.join(root, CONFIG_FILE), JSON.stringify(next, null, 2), 'utf8')
    await sync()
    return next
  }

  // 条件满足时有链在跑，就等所有链跑完再进化：不打断在跑的链
  function want(by) {
    if (!pending) pending = { by, root: getRoot() }
    tryPending()
  }

  async function tryPending() {
    if (!pending || current || !isIdle()) return
    const { by, root } = pending
    pending = null
    if (root !== getRoot() || !(await readConfig(root)).auto) return
    await start({ by }).catch(() => {})
  }

  // 运行器每往 runs.jsonl 追加一行，看一次 runs 和 streak
  async function recorded(entry) {
    const root = getRoot()
    if (!root || current || pending) return
    const settings = await readConfig(root)
    if (!settings.auto) return
    const by = await triggerOf(root, settings, entry.node)
    if (by) want(by)
  }

  // 每天几点：按这份工作文件夹的配置排一个时刻。换文件夹、改配置之后重排。
  async function sync() {
    clearTimeout(dailyTimer)
    dailyTimer = null
    const root = getRoot()
    if (!root) return
    const settings = await readConfig(root)
    if (!settings.auto || !settings.daily) return
    const delay = nextFireAt(parseSchedule(settings.daily)) - Date.now()
    if (delay > MAX_DELAY_MS) return
    dailyTimer = setTimeout(() => {
      dailyTimer = null
      want('daily')
      sync()
    }, delay)
  }

  return {
    start,
    undo,
    restore,
    history,
    record,
    config,
    recorded,
    idle: tryPending,
    sync,
    status,
    readLog,
    active: () => Boolean(current),
  }
}
