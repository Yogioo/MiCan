// 运行器：跑一个节点，或从入口走完整条链（ADR-0006）。
// 前端只发起和订阅，链在这儿跑 —— 页面关掉也照跑（ADR-0005 的定时触发以后也从这里进）。
// 它自己读画布、按数据边拼命令、把结果写盘；graph / chain / vars / pick / paths 都是纯 ESM，直接共用。
import fs from 'node:fs/promises'
import path from 'node:path'
import { routeFrom } from '../src/core/chain.mjs'
import { dataInto, dataOut, execIn, execOutAll, extensionOf, findNode, runnable, trigger as isTrigger } from '../src/core/graph.mjs'
import { CANVAS_FILE, cacheFile } from '../src/core/paths.mjs'
import { pickValue } from '../src/core/pick.mjs'
import { deserialize, resultMeta } from '../src/core/serialize.mjs'
import { applyCanvas, canvas } from '../src/core/settings.mjs'
import { applyVars, collectVars } from '../src/core/vars.mjs'
import { startCommand } from './exec.mjs'
import { commandOf } from './extensions.mjs'

// 跑完的记录留一会儿再扔：事件流断过的页面重连时还补得上最后那句话。
const KEEP_DONE_MS = 2 * 60 * 1000
// 提示里别把一整份输出塞进去
const clip = (text) => (text.length > 24 ? `${text.slice(0, 24)}…` : text)

export function createRunner({ getRoot, resolveCwd, readSettings }) {
  const runs = new Map()
  let seq = 0
  const nextId = () => `r${Date.now().toString(36)}${(seq += 1).toString(36)}`

  // 运行器此刻占着哪些东西：从这一步开始，这些节点的缓存文件、md 和存档里的元信息都由它写。
  // 前端的整包落盘（server/api.mjs 的 save）照这份名单跳过它们，免得把刚写下的盖回旧的（ADR-0009）。
  const ownedBy = (pick) => {
    for (const run of runs.values()) if (run.active && pick(run)) return true
    return false
  }
  const owns = (id) => ownedBy((run) => run.ids.has(id))
  const ownsFile = (file) => ownedBy((run) => run.files.has(file))

  // ---- 事件 ----

  function emit(run, event) {
    run.events.push(event)
    for (const send of run.subscribers) send(event)
  }

  function finish(run, outcome, message) {
    if (!run.active) return
    run.active = false
    run.current = null
    run.finishedAt = Date.now()
    emit(run, { t: 'end', outcome, message, steps: run.step })
    run.subscribers.clear()
    setTimeout(() => runs.delete(run.id), KEEP_DONE_MS).unref()
  }

  const failMessage = (run, step, result) =>
    run.mode === 'node' ? `退出码 ${result.code}，没有覆写下游文本节点` : `第 ${step} 步退出码 ${result.code}，链停在这儿`
  const stopMessage = (run, steps) => (run.mode === 'node' ? '已停止，没有覆写下游文本节点' : `已停止：跑了 ${steps} 步`)
  const stepMessage = (run, step, reason) => (run.mode === 'node' ? reason : `第 ${step} 步没跑起来：${reason}`)

  // ---- 盘上的画布 ----

  // 跑之前前端已经落过盘（ADR-0003），所以盘上这份就是最新的。
  // 顺带把缓存文件读回来：单独跑下游时，上游的值（{{名字}}）要从这儿补。
  async function loadGraph(root) {
    const raw = await fs.readFile(path.join(root, CANVAS_FILE), 'utf8').catch(() => null)
    if (raw === null) throw new Error('这个文件夹里没有画布存档（mican.json）')
    const { graph, settings } = deserialize(JSON.parse(raw))
    applyCanvas(settings) // 步数上限、画布运行目录都在这份存档里
    for (const node of graph.nodes) {
      if (node.result) node.result.output = await fs.readFile(path.join(root, cacheFile(node.id)), 'utf8').catch(() => '')
    }
    return graph
  }

  // 存档的补写：只动这次跑出来的那两处（results 里的一格、下游文本节点的正文）。
  // 现读现改，不整包盖回去 —— 前端可能刚改过结构、位置、别的节点。
  async function patchArchive(root, { results = {}, texts = {} }) {
    const file = path.join(root, CANVAS_FILE)
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    data.results = { ...(data.results ?? {}), ...results }
    for (const node of data.nodes ?? []) if (texts[node.id] !== undefined) node.text = texts[node.id]
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
  }

  // ---- 值 ----

  // 一个节点的值的正文：文本节点是那份 md，会跑的节点是最近一次运行的输出。
  const valueText = (node) => (!node ? '' : node.kind === 'text' ? (node.text ?? '') : (node.result?.output ?? ''))
  // 提取节点的源：默认取执行来路那个节点的值（先后由执行边给），有数据入边就用那份文本。
  function sourceTextOf(graph, id) {
    const edge = dataInto(graph, id)[0]
    if (edge) return valueText(findNode(graph, edge.from))
    const inEdge = execIn(graph, id)
    return inEdge ? valueText(findNode(graph, inEdge.from)) : ''
  }

  // 命令的运行目录：节点自己设了就用节点的（覆盖），没设就看这份画布的，都没有就是工作文件夹。
  const runDirOf = (node) => node.cwd || canvas.cwd || ''

  // ---- 跑一步 ----

  async function runStep(run, id, step) {
    const graph = run.graph
    const node = findNode(graph, id)
    if (!node || !runnable(node)) return { error: '这个节点运行不了' }

    // 只有数据边把输出带得走；执行边只表达先后，不带数据
    const targets = dataOut(graph, id)
      .map((edge) => findNode(graph, edge.to))
      .filter((item) => item?.kind === 'text')
    // 这一步要写的东西先记下：从这一刻起它们归运行器，前端的落盘要跳过
    run.step = step
    run.ids.add(id)
    for (const item of targets) {
      run.ids.add(item.id)
      run.files.add(item.file)
    }
    const startedAt = Date.now()

    // 先验一遍再动手：验不过就当没跑过，节点上原来那份输出留着（跟搬进后端之前一样）。
    // 验过了才报「这一步开跑」—— 那件事的意思是「有个进程跑起来了」，提取节点没有进程。
    if (node.kind === 'extract') {
      // 提取节点不 spawn 任何进程：拿源文本按取法取出一个字符串，那就是它的值
      const { value, error } = pickValue(sourceTextOf(graph, id), node.pick ?? '')
      if (error) return { error: `提取不出值：${error}` }
      return { ...(await settle(run, node, { output: value, at: Date.now(), elapsed: Date.now() - startedAt }, targets)), targets: targets.length }
    }

    // 命令从哪来：手写的在节点上；引用扩展的现读那份清单拼一条 —— 节点存的是引用，
    // 改扩展对所有引用它的节点立刻生效（ADR-0014）。扩展读不到就停在这一步。
    const ext = extensionOf(node)
    let template = node.command
    if (ext) {
      try {
        template = (await commandOf(run.root, ext)).command
      } catch (error) {
        return { error: error.message }
      }
    } else if (!template.trim()) return { error: '这个命令节点还没有命令' }
    // 变量注入只改这一次要跑的命令，节点上的模板不动；取值是「此刻」的
    const { vars, errors } = collectVars(graph, id, run.root)
    const injected = applyVars(template, vars)
    const problems = [...new Set([...errors, ...injected.problems])]
    if (problems.length) return { error: `变量没对上：${problems.join('；')}` }
    const cwd = await resolveCwd(runDirOf(node)) // 运行目录不存在就停在起跑线上

    run.current = { nodeId: id, output: '', startedAt, child: null }
    emit(run, { t: 'step', nodeId: id, step, startedAt, targets: targets.map((item) => item.id) })
    const settings = await readSettings()
    const child = startCommand({
      command: injected.command,
      cwd,
      shell: settings.shell,
      timeout: settings.timeout,
      outputLimit: settings.outputLimitKb * 1024,
      onChunk: (text) => {
        run.current.output += text
        emit(run, { t: 'chunk', nodeId: id, data: text })
      },
    })
    run.current.child = child
    const record = await child.done
    run.current.child = null
    const result = {
      code: record.code,
      failed: record.failed,
      stopped: record.stopped,
      timedOut: record.timedOut,
      truncated: record.truncated,
      output: record.output,
      command: injected.command, // 实际跑的命令（变量已替换），留着让节点上能回看
      at: Date.now(),
      elapsed: Date.now() - startedAt, // 跑完也留着，脚上照样看得到跑了多久
    }
    return { ...(await settle(run, node, result, targets)), targets: targets.length }
  }

  // 结果三处落地：裸输出进缓存文件、正文进下游文本节点的 md、元信息补进存档，
  // 然后告诉前端这一步完了。停止或失败都不覆写下游文本节点。
  async function settle(run, node, result, targets) {
    node.result = result
    const cache = path.join(run.root, cacheFile(node.id))
    await fs.mkdir(path.dirname(cache), { recursive: true })
    await fs.writeFile(cache, result.output ?? '', 'utf8')
    const written = result.failed ? [] : targets
    for (const item of written) {
      const file = path.join(run.root, item.file)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, result.output ?? '', 'utf8')
      item.text = result.output ?? '' // 下游拿它当值（{{名字}}），所以内存里也得跟着换
    }
    const texts = written.map((item) => ({ nodeId: item.id, text: result.output }))
    await patchArchive(run.root, {
      results: { [node.id]: resultMeta(node) },
      texts: Object.fromEntries(texts.map((item) => [item.nodeId, item.text])),
    })
    emit(run, { t: 'done', nodeId: node.id, result, texts })
    return { result }
  }

  // ---- 走路 ----

  // 每一步「当前节点跑完，拿它的值按标签挑一根执行出边」，走到走不下去为止。
  // 出边可以成环，所以兜「跑飞了」的只有步数上限（存档配置 canvas.stepLimit）。
  async function walk(run) {
    const limit = canvas.stepLimit
    // 触发节点自己不跑（它只是「从这儿开始」）：第一步在 start 里就算好了，就是 run.headId
    let cursor = run.headId
    for (let step = 1; step <= limit; step += 1) {
      if (run.stopped) return finish(run, 'stopped', stopMessage(run, step - 1))
      const outcome = await runStep(run, cursor, step)
      if (outcome.error) return finish(run, 'error', stepMessage(run, step, outcome.error))
      // 停止有两处：当前这条命令被掐掉（结果里标了 stopped），或停在了两步之间的空档
      const result = outcome.result
      if (result.stopped || run.stopped) return finish(run, 'stopped', stopMessage(run, step))
      if (result.failed) return finish(run, 'failed', failMessage(run, step, result))
      if (run.mode === 'node') {
        return finish(run, 'ok', outcome.targets ? `输出已灌给 ${outcome.targets} 个下游文本节点` : '没有下游文本节点，输出只显示在节点上')
      }
      const value = (result.output ?? '').trim()
      const next = routeFrom(run.graph, cursor, value)
      if (next.done) return finish(run, 'ok', `链路跑完：${step} 步，走到一个没有出边的节点`)
      if (next.stuck) {
        // 它本来可能走的那几根都记上「未运行」，不然分不清「没走」和「走了是空的」
        emit(run, { t: 'skipped', ids: [...new Set(execOutAll(run.graph, cursor).map((edge) => edge.to))] })
        return finish(run, 'stuck', `第 ${step} 步的值是「${clip(value)}」，出边上的标签是「${next.labels.join('、')}」，一根都不匹配，停在这儿`)
      }
      cursor = next.to
    }
    return finish(run, 'limit', `走了 ${limit} 步还没停，多半是环没兜住，停下来别再走了`)
  }

  // ---- 对外的四件事 ----

  async function start({ id, mode = 'node', trigger = 'manual' }) {
    const root = getRoot()
    if (!root) throw new Error('先打开一个工作文件夹，命令才有地方跑')
    if (owns(id)) throw new Error('这个节点还在跑，等它结束')
    const graph = await loadGraph(root)
    const node = findNode(graph, id)
    if (!node) throw new Error('这个节点不在画布上')
    // 跑链从触发节点（入口或定时器）出发：它自己没有进程，第一步是它那根出边指到的节点
    if (mode === 'chain' ? !isTrigger(node) : !runnable(node)) {
      throw new Error(mode === 'chain' ? '跑链得从入口节点或定时器开始' : '这个节点运行不了')
    }
    // 这条链的「链身」从哪个会跑的节点起步。跳过判断看它，不看是谁点的火 ——
    // 同一个命令，人手从入口进来与定时器进来是同一条链，不该同时跑两遍。
    const head = mode === 'chain' ? execOutAll(graph, id)[0]?.to : id
    if (!runnable(findNode(graph, head))) throw new Error(mode === 'chain' ? '它还没连到会跑的节点' : '这个节点运行不了')
    if (mode === 'chain' && isRunning(head)) throw new Error('这条链还在跑，等它结束')

    const run = {
      id: nextId(),
      mode,
      trigger, // 谁开的这一次：manual 是人点的，timer 是定时器到点（后端自己开的）
      nodeId: id,
      headId: head,
      startedAt: Date.now(),
      step: 0,
      active: true,
      stopped: false,
      ids: new Set([id]),
      files: new Set(),
      graph,
      root,
      events: [],
      subscribers: new Set(),
      current: null,
    }
    runs.set(run.id, run)
    emit(run, { t: 'run', runId: run.id, mode, nodeId: id, startedAt: run.startedAt, trigger: run.trigger })
    // 不等它跑完：调用方拿 runId 就去订阅事件了
    walk(run).catch((error) => finish(run, 'error', `跑链出错了：${error.message}`))
    return { runId: run.id }
  }

  // 停止：掐掉正在跑的那条命令；空档里没有进程可掐，记一笔让走路下一圈自己停
  function stop(runId) {
    const run = runs.get(runId)
    if (!run || !run.active) throw new Error('这次运行已经结束了')
    run.stopped = true
    run.current?.child?.stop()
    return { ok: true }
  }

  // 在跑的与刚跑完的都列出来：前者是「现在有个链在走」，后者是「刚刚走了这一下」。
  // 一秒一条链的话，只列在跑的根本抓不住 —— 每 1 秒问一次也只碰得上十分之一。
  // 刚跑完的会带上 complete 事件（含这次输出），页面迟到一步也能把这一步补上。
  const list = () =>
    [...runs.values()].map((run) => ({
      runId: run.id,
      mode: run.mode,
      trigger: run.trigger,
      nodeId: run.nodeId,
      startedAt: run.startedAt,
      active: run.active,
      finishedAt: run.finishedAt ?? null,
      step: run.step,
      currentNodeId: run.current?.nodeId ?? null,
    }))

  // 订阅：后来的（刷新过的页面）先把历史补上，再跟着看后面的。
  // 返回退订函数；认不出这个 runId 就返回 null（那次运行的记录已经扔了）。
  function attach(runId, send) {
    const run = runs.get(runId)
    if (!run) return null
    for (const event of run.events) send(event)
    if (!run.active) return () => {}
    run.subscribers.add(send)
    return () => run.subscribers.delete(send)
  }

  // 有没有一条从某个会跑的节点起步的链还在走。定时器拿它判断「上一条还没跑完就跳过这一次」：
  // 人手从入口跑同一条链时定时器也看得见 —— 它们指的是同一个起步节点，本来就是同一条链。
  const isRunning = (headId) => [...runs.values()].some((run) => run.active && run.headId === headId)

  return { start, stop, list, attach, owns, ownsFile, isRunning, has: (runId) => runs.has(runId) }
}
