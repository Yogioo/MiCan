// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import {
  baseName,
  createGraph,
  createNode,
  findEdge,
  findNode,
  fitInputPorts,
  removeEdge,
  removeNode,
  runnable,
  setNodeCwd,
  setNodeText,
  uniqueName,
} from '../core/graph.mjs'
import { CMD_BAR_H, curveHitsBox, edgeCurve, rectsOverlap } from '../core/geometry.mjs'
import { inputsOf, outputsOf, sourcePortIndex, targetPortIndex } from '../core/inputs.mjs'
import { FORMAT_VERSION, deserialize, serialize, textsOf } from '../core/serialize.mjs'
import { applyPaste, snapshotSelection } from '../core/duplicate.mjs'
import { applyBoard, applyCanvas, applyMachine, canvas, machine } from '../core/settings.mjs'
import { parseSchedule } from '../core/schedule.mjs'
import { createHistory, push, redo as redoHistory, undo as undoHistory } from '../core/history.mjs'
import { createView, zoomAt } from '../core/view.mjs'
import { mountBoard } from './board.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountEvolveWindow } from './evolve-window.mjs'
import { mountNodes } from './nodes.mjs'
import { askSettings } from './settings-dialog.mjs'
import { mountToolbar } from './toolbar.mjs'
import { askRunDir, askUndoReason, askWorkspace, confirmRestore } from './workspace-dialog.mjs'

export const state = {
  view: createView(),
  graph: createGraph(),
  // 选中的节点与边：一个 id 集合，空集合就是没选。节点 id（n 开头）与边 id（e 开头）
  // 不重号，所以两类混在一处也认得出来，删的时候分开处理就是。
  selection: new Set(),
  workspace: null, // 工作文件夹的绝对路径，未打开时为 null
  slots: {}, // 面板属性此刻盘上的正文（.mican/board/<名字>.md），不进存档
  // 工作文件夹里 extensions/ 扫出来的菜单树（扩展）：{ items, problems }。跟着工作文件夹走，不进存档
  extensions: { items: [], problems: [] },
  // 跟机器走的那些值（命令行、超时、界面手感）不住在这儿：它们住在 core/settings.mjs，现读现用；
  // 运行目录属于画布，在 canvas.cwd
  running: new Map(), // 运行中的命令节点：id -> 开跑时间。只活在内存里，不进存档
  // 后端在跑的每一次运行：runId -> { mode, nodeId, startedAt, nodes }。链也是其中一条，
  // 它不由某个进程代表（两步之间的空档也在跑），所以右下角那个停止按钮看的是这张表。
  runs: new Map(),
  saving: false, // 有一次落盘还在路上
  evolve: null, // 后端的进化状态 { active, phase, last }，轮询带回来
  evolved: new Set(), // 这次进化改过的节点：画布上标出来，关掉进化窗口才收
  message: '',
}

const subscribers = new Set()

// 撤销：只认结构变化，连拖时快速连发的改动合并成一步。
// 合并窗口多久算「一次改动」在设置里（machine.undoMergeMs）。
const history = createHistory()
let lastRecord = 0

// 逻辑、布局、正文三份都要：拆存档之后它们不在一处了（ADR-0023）
function graphSnapshot() {
  const { canvas, layout } = serialize(state)
  return JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges, layout: layout.nodes, texts: textsOf(state.graph) })
}

// 布局里没有的节点，没有上游就摆在视口中间
function viewCenter(view) {
  const viewport = document.getElementById('viewport')
  const ok = view && Number.isFinite(view.x) && Number.isFinite(view.y) && view.scale > 0
  const { x, y, scale } = ok ? view : state.view
  return { x: (viewport.clientWidth / 2 - x) / scale, y: (viewport.clientHeight / 2 - y) / scale }
}

function viewKey() {
  const { x, y, scale } = state.view
  return `${x},${y},${scale}`
}

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
}

function notify() {
  for (const fn of subscribers) fn(state)
}

export function update(mutate) {
  const before = graphSnapshot()
  const wasView = viewKey()
  mutate(state)
  const after = graphSnapshot()
  if (after !== before) {
    const now = Date.now()
    if (now - lastRecord > machine.undoMergeMs) push(history, before)
    lastRecord = now
  }
  // 视口也算画布状态，所以平移缩放同样要落盘；连拖时防抖会把它们并成一次
  if (after !== before || viewKey() !== wasView) scheduleSave()
  notify()
}

function resetHistory() {
  history.past.length = 0
  history.future.length = 0
  lastRecord = 0
}

// 接口

async function api(route, body) {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `请求失败（${response.status}）`)
  return data
}

let messageTimer = null

function showMessage(text) {
  update((draft) => {
    draft.message = text
  })
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => update((draft) => { draft.message = '' }), machine.messageMs)
}

// ---- 落盘 / 另存为 / 打开 ----

// 最近打开过的文件夹，由后端记着（换浏览器、换端口都还在）。
let recent = []

async function loadRecent() {
  try {
    recent = (await api('/api/recent', {})).items ?? []
  } catch {
    recent = []
  }
}

// 全局配置（命令行、超时…）也由后端记着，跟这台机器走，不进画布存档；运行目录在存档里，见 core/settings.mjs 的 canvas。
// 全局设置读回来就收进 core/settings.mjs 那份机器配置里：界面和命令都现读它。
// 它不属于画布状态（不进存档、不进撤销），所以改完只重绘一下。
async function loadSettings() {
  try {
    applyMachine(await api('/api/settings', {}))
    notify()
  } catch {
    // 读不到就当没设
  }
}

// 改动一结束就把内存镜像到工作文件夹（ADR-0003）：没有「保存」这个动作，也没有「未保存」这个状态。
// 防抖只是把连发的改动并成一次；真正保证新鲜的是「跑命令之前先 flush」。

let scheduled = null // 防抖计时器（时长在设置里：machine.autosaveMs）
let queue = Promise.resolve() // 落盘串成一条链，免得两次写撞在一起
let inFlight = 0

function payload() {
  const docs = state.graph.nodes
    .filter((node) => node.kind === 'text')
    .map((node) => ({ file: node.file, content: node.text }))
  // 缓存文件就是节点的值：裸输出写文件，元信息在 .mican/results.json（只由后端写）。
  // 命令节点和提取节点都一样，所以过滤按「会不会跑」来，不按 kind 写死。
  // 两份文件一起推：.out 是值（stdout），.log 是诊断（stderr）—— 节点正文优先显示后者。
  const ran = state.graph.nodes.filter((node) => runnable(node) && node.result)
  const cache = ran.map((node) => ({ id: node.id, content: node.result.output ?? '' }))
  const logs = ran.map((node) => ({ id: node.id, content: node.result.log ?? '' }))
  return { ...serialize(state), docs, cache, logs }
}

// 进化期间后端不收落盘：做完会从盘上重开
function scheduleSave() {
  if (!state.workspace || state.evolve?.active) return
  clearTimeout(scheduled)
  scheduled = setTimeout(saveNow, machine.autosaveMs)
}

// 立刻写一次。命令跑完、链路每一步之后都靠它 —— 缓存文件得马上在盘上。
function saveNow() {
  clearTimeout(scheduled)
  scheduled = null
  if (!state.workspace || state.evolve?.active) return Promise.resolve()
  const body = payload() // 先取一份：排进队列之后状态再变，也不影响这一次写的内容
  inFlight += 1
  state.saving = true
  notify()
  queue = queue.then(() => api('/api/save', body)).then(
    () => settleSave(null),
    (error) => settleSave(error.message),
  )
  return queue
}

function settleSave(failure) {
  inFlight -= 1
  state.saving = inFlight > 0
  if (failure) showMessage(`落盘失败：${failure}`)
  else notify()
}

// 跑命令之前必须把待写的改动写完：命令要读的 md 和缓存文件都得是最新的。
async function flush() {
  if (scheduled) return saveNow()
  return queue
}

// 后端把这次的文件夹排到了历史最前面，前端跟着换一份。
function remember(response) {
  recent = response.recent ?? recent
}

// 菜单里的扩展跟着工作文件夹走（ADR-0012）：换一个文件夹就重扫一遍。
// 认不出来的那几个只报一句，不挡住别的 —— 一个坏扩展不该让整张菜单空掉。
async function loadExtensions() {
  const empty = { items: [], problems: [] }
  try {
    state.extensions = state.workspace ? await api('/api/extensions', {}) : empty
  } catch (error) {
    state.extensions = empty
    showMessage(`读扩展失败：${error.message}`)
    return
  }
  notify()
  fitAllInputPorts()
  if (state.extensions.problems?.length) {
    showMessage(`${state.extensions.problems.length} 个扩展没认出来：${state.extensions.problems[0]}`)
  }
}

// 输入端口是命令（扩展节点则是清单的 args）带出来的，节点高度却是用户拉的 ——
// 改过命令的旧存档可能太矮，端口会被挤到框外。工作文件夹与扩展都到位之后兜一遍。
// 不走 update()：这是载入时的就地掰正，不该进撤销栈。
function fitAllInputPorts() {
  let grown = false
  for (const node of state.graph.nodes) {
    const count = Math.max(inputsOf(node, state.extensions).length, outputsOf(node, state.extensions).length)
    if (fitInputPorts(state.graph, node.id, count)) grown = true
  }
  if (!grown) return
  scheduleSave()
  notify()
}

// 打开 / 另存为之后，画布与磁盘就是一致的，所以直接把状态按上去，不排落盘。
// next 就是接下来要用的那份 { graph, view }：打开时是读出来的，另存为时就是手上这份。
function adoptWorkspace(root, next) {
  clearTimeout(scheduled)
  scheduled = null
  state.workspace = root
  state.graph = next.graph
  state.view = next.view
  state.selection = new Set()
  notify()
  loadExtensions()
}

async function saveAs() {
  let initial = ''
  let error = ''
  for (;;) {
    const answer = await askWorkspace({ mode: 'create', initial, recent, error })
    if (!answer) return
    try {
      const response = await api('/api/workspace', { path: answer.path, mode: 'create' })
      remember(response)
      adoptWorkspace(response.root, { graph: state.graph, view: state.view })
      await saveNow() // 新文件夹里什么都没有，把当前画布整个写过去
      showMessage('已另存为新的工作文件夹')
      return
    } catch (failure) {
      initial = answer.path // 弹窗重新开，错误写在里面，路径不用重打
      error = `另存为失败：${failure.message}`
    }
  }
}

// 打开一个工作文件夹：把存档读回来装上。弹窗那条路和「启动时自动打开」那条路都走它。
async function loadWorkspace(path) {
  const response = await api('/api/workspace', { path, mode: 'open' })
  remember(response)
  const restored = response.archive ? deserialize(response.archive, { center: viewCenter(response.archive.layout?.view) }) : null
  const cache = response.cache ?? {}
  const logs = response.logs ?? {}
  // 元信息在 results 里、裸输出在缓存文件里、诊断在 .log 里，三份合起来才是一个完整的结果
  if (restored) {
    for (const node of restored.graph.nodes) {
      if (!runnable(node) || !node.result) continue
      node.result.output = cache[node.id] ?? ''
      node.result.log = logs[node.id] ?? ''
    }
    applyCanvas(restored.settings) // 跟这份画布走的设置（步数上限这类）跟着存档换
    applyBoard(restored.board) // 面板跟着存档换；没有这个键就是空表
  } else {
    applyBoard(null)
  }
  state.slots = response.slots ?? {}
  adoptWorkspace(response.root, restored ?? { graph: createGraph(), view: state.view })
  if (restored?.placed.length) scheduleSave() // 现摆的位置记进布局
  evolveWindow.refresh() // 进化的配置和记录跟工作文件夹走
  return restored
}

async function openWorkspace() {
  let initial = state.workspace ?? recent[0] ?? ''
  let error = ''
  for (;;) {
    const answer = await askWorkspace({ mode: 'open', initial, recent, error, startup: machine.openWorkspace === initial })
    if (!answer) return
    try {
      const restored = await loadWorkspace(answer.path)
      const note = await rememberStartup(answer.path, answer.startup)
      resetHistory()
      showMessage(`${restored ? '已打开' : '文件夹里没有画布存档，按空白画布打开'}${note}`)
      return
    } catch (failure) {
      initial = answer.path
      error = `打开失败：${failure.message}`
    }
  }
}

// 「以后启动时打开它」：勾了就把这个文件夹记进全局配置，取消勾就把原来那个清掉。
// 它的家在「打开」弹窗而不是设置窗口 —— 你开哪个文件夹的时候才想得起来这件事。
async function rememberStartup(path, wanted) {
  const next = wanted ? path : ''
  if (next === machine.openWorkspace) return ''
  try {
    applyMachine(await api('/api/settings', { openWorkspace: next }))
    return next ? '，以后启动就打开它' : ''
  } catch (error) {
    return `（没能记住启动文件夹：${error.message}）`
  }
}

// 启动时打开设置里指定的那个工作文件夹；没设就等你自己点「打开」。
async function openStartupWorkspace() {
  if (!machine.openWorkspace || state.workspace) return
  try {
    await loadWorkspace(machine.openWorkspace)
    resetHistory()
  } catch (error) {
    showMessage(`设置里那个启动工作文件夹打不开：${error.message}`)
  }
}

// ---- 节点 ----

function createNodeAt(world, kind, extra = {}) {
  if (state.evolve?.active) return // 进化期间画布只读
  const compact = kind === 'get' || kind === 'set'
  const w = compact ? 200 : machine.nodeDefaultW
  const h = kind === 'get' ? CMD_BAR_H : compact ? 88 : machine.nodeDefaultH
  const node = createNode({
    kind,
    x: world.x - w / 2,
    y: world.y - h / 2,
    w,
    h,
    ...extra,
  })
  node.name = uniqueName(state.graph.nodes, baseName(node))
  // 清单里的默认值**不**填进节点：那个框留空，跑的时候由后端拿默认值兜底（ADR-0015）。
  // 框里只剩一句灰色的「默认 …」当提示 —— 拖出来是一张干净的节点。
  const ports = Math.max(inputsOf(node, state.extensions).length, outputsOf(node, state.extensions).length)
  update((draft) => {
    draft.graph.nodes.push(node)
    // 端口几个落地前就知道了，高度当场兜够
    if (node.extension) fitInputPorts(draft.graph, node.id, ports)
    draft.selection = new Set([node.id])
  })
}

function deleteSelection() {
  if (!state.selection.size) return
  update((draft) => {
    for (const id of [...state.selection]) {
      // 边自己删；节点连它身上的边一起删（removeNode）—— 两类 id 混在一处，分得出来。
      if (findEdge(draft.graph, id)) removeEdge(draft.graph, id)
      else removeNode(draft.graph, id)
    }
    draft.selection = new Set()
  })
}

// 复制：只活在内存里。抄的是选中的节点，加两端都在这批里的边。
let clipboard = null
let pasteN = 0

function copySelection() {
  const clip = snapshotSelection(state.graph, state.selection)
  if (!clip) return false
  clipboard = clip
  pasteN = 0
  return true
}

function pasteSelection() {
  if (!clipboard) return
  pasteN += 1
  const delta = machine.gridStep
  update((draft) => {
    const { nodes } = applyPaste(draft.graph, clipboard, delta * pasteN, delta * pasteN)
    draft.selection = new Set(nodes.map((node) => node.id))
  })
}

function duplicateSelection() {
  if (!copySelection()) return false
  pasteSelection()
  return true
}

function clearSelection() {
  if (!state.selection.size) return
  update((draft) => {
    draft.selection = new Set()
  })
}

// ---- 运行命令 ----

let ticking = null

// 秒表：靠定期整帧重绘刷新脚上的秒数，没有命令在跑就停掉。
function startTicking() {
  if (ticking) return
  ticking = setInterval(() => update(() => {}), 500)
}

function stopTicking() {
  if (state.running.size || !ticking) return
  clearInterval(ticking)
  ticking = null
}

// 在飞的订阅：runId -> AbortController。只活在内存里，退订用。
const aborts = new Map()
// 这里自己发起的运行：它们的结束语要报一句（「链路跑完：3 步」）。
// 定时器那些不报 —— 一秒一条的话，那句话会一直在工具条上滚动。
const startedHere = new Set()

// 停止：逐条发到后端 —— 跑的是它，断链也得是它。光断订阅断不掉：
// 订阅断了只是不看了，链还在后端走（ADR-0009）。
function stopRunning() {
  for (const runId of state.runs.keys()) {
    api(`/api/run/${runId}/stop`, {}).catch((error) => showMessage(error.message))
  }
}

// ---- 运行 ----
// 跑命令和跑链路都在后端（ADR-0006）：它自己读画布、自己走路、自己把结果写盘，
// 所以页面关掉也照跑；这里只把事件流摊到界面上。

async function startRun(mode, id) {
  await flush() // 它要读盘上的画布与缓存文件，待写的先写完
  try {
    const { runId } = await api('/api/run', { mode, id })
    startedHere.add(runId)
    watchRun(runId)
  } catch (error) {
    showMessage(error.message)
  }
}

const onRunCommand = (id) => startRun('node', id)
const onRunChain = (id) => startRun('chain', id)

// 右下角那个「开始」：从入口节点出发跑链。入口可以有好几枚（将来的子图各有各的入口），
// 所以它把每一枚入口都点着：已经有一条从同一个起步节点出发的链在走时，那一条报一声，别的照常。
async function startFromEntries() {
  const entries = state.graph.nodes.filter((node) => node.kind === 'entry')
  if (!entries.length) return showMessage('画布上没有入口节点：放一枚入口，连到第一个会跑的节点')
  for (const node of entries) await startRun('chain', node.id)
}

// 网页重开时后端可能还有链在走（页面关着也跑），定时器到点也会自己开跑（ADR-0005）——
// 这两件事都没有人点过「运行」，所以页面自己去问：每几秒拉一次「在跑的 + 刚触发的」。
// 没见过的 runId 接上事件流（attach 会把历史补上，所以就算这次已经跑完也接得到）；
// 触发记录摊到定时器节点上，跳过的那一下才看得见。
const seenRuns = new Set()
let triggerSeq = 0
// 页面打开之前响过的，存档里已经带着了（loadWorkspace 把 results 读回来了），不用再摊一遍
const openedAt = Date.now()
// 后端触发的运行没人在页面上通知，只能自己去问，所以这一圈一直在转。
// 问多勤看这份画布上最快的那个定时器：有秒级的就 1 秒问一次，否则 3 秒就够（
// 在跑的链本来就以秒、分钟计，早 2 秒知道没意义）。
const POLL_SLOW_MS = 3000
const POLL_FAST_MS = 1000
let pollTimer = null

function pollDelay() {
  let fastest = Infinity
  for (const node of state.graph.nodes) {
    if (node.kind !== 'timer') continue
    const every = parseSchedule(node.schedule)?.every
    if (every) fastest = Math.min(fastest, every)
  }
  return fastest < POLL_SLOW_MS ? POLL_FAST_MS : POLL_SLOW_MS
}

// 自己接着自己排：间隔随时可以变（刚把定时器改成秒级就能跟上）
async function pollLoop() {
  await pollRuns()
  clearTimeout(pollTimer)
  pollTimer = setTimeout(pollLoop, pollDelay())
}

async function pollRuns() {
  if (!state.workspace) return
  let answer
  try {
    answer = await api('/api/runs', {})
  } catch {
    return // 后端不在就先不管，下一圈再说
  }
  // 在跑的 + 刚跑完的都接上：一秒一条链的时候，只接在跑的根本抓不住。
  // 页面打开之前就跑完的不用接 —— 它们的结果早就在存档里，loadWorkspace 已经读回来了。
  for (const item of answer.items ?? []) {
    const endedAt = item.finishedAt ?? item.startedAt
    if (!item.active && endedAt < openedAt) continue
    watchRun(item.runId)
  }
  for (const hit of answer.triggers ?? []) {
    if (hit.seq <= triggerSeq) continue
    triggerSeq = hit.seq
    if (hit.at >= openedAt) applyTrigger(hit) // 打开页面之前的那几笔已经在存档里了
  }
  // 页面是进化中途打开的：接上进化窗口
  if (answer.evolve?.active) watchEvolve(answer.evolve)
}

// ---- 进化 ----

// 进化、撤销、还原都一样：先把画布落盘（诊断、pi、git 读的都是盘上那份），然后跟着看过程
async function beginEvolve(route, body) {
  await flush()
  try {
    watchEvolve(await api(route, body))
  } catch (error) {
    showMessage(error.message)
  }
}

async function startEvolve(hint) {
  if (!state.workspace || state.evolve?.active) return
  await beginEvolve('/api/evolve', { hint })
}

async function undoEvolve(entry) {
  if (!state.workspace || state.evolve?.active) return
  const reason = await askUndoReason(entry.commit)
  if (reason === null) return
  await beginEvolve('/api/evolve/undo', { commit: entry.commit, reason })
}

async function restoreEvolve(entry, lost) {
  if (!state.workspace || state.evolve?.active) return
  if (!(await confirmRestore(entry.commit, lost))) return
  await beginEvolve('/api/evolve/restore', { commit: entry.commit })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const EVOLVE_POLL_MS = 1000
let watching = false
let evolveLog = { id: 0, size: 0 } // 进化窗口已经铺到这次过程的第几个字
let baseline = new Map() // 进化开始时每个节点的样子，拿来标「进化改过」
let liveKey = ''

// 「改过」只看逻辑和正文：pi 不碰布局
const nodeKeys = (graph) => {
  const texts = textsOf(graph)
  return new Map(serialize({ view: state.view, graph }).canvas.nodes.map((node) => [node.id, JSON.stringify([node, texts[node.id]])]))
}

// 进化期间每秒问一次：新增的过程铺进窗口，盘上的画布变了就原地换上。做完从盘上重开。
async function watchEvolve(status) {
  if (watching) return
  watching = true
  state.evolve = status
  baseline = nodeKeys(state.graph)
  liveKey = ''
  state.evolved = new Set()
  evolveWindow.open()
  notify()
  for (;;) {
    let answer
    try {
      answer = await api('/api/evolve/watch', { id: evolveLog.id, from: evolveLog.size })
    } catch {
      await sleep(EVOLVE_POLL_MS)
      continue
    }
    // 换了一次进化：后端给的是整段，窗口从头铺
    if (answer.status.logId !== evolveLog.id) {
      evolveWindow.reset()
      evolveLog = { id: answer.status.logId, size: 0 }
    }
    evolveWindow.append(answer.log)
    evolveLog.size += answer.log.length
    state.evolve = answer.status
    if (answer.archive) showLiveCanvas(answer.archive)
    notify()
    if (!answer.status.active) break
    await sleep(EVOLVE_POLL_MS)
  }
  watching = false
  await afterEvolve()
}

// pi 改到一半的画布：只拿来看，不进撤销、不落盘。运行结果按 id 接回来。
function showLiveCanvas(archive) {
  const key = JSON.stringify([archive.canvas.nodes, archive.canvas.edges, archive.texts])
  if (key === liveKey) return
  liveKey = key
  let restored
  try {
    restored = deserialize(archive, { center: viewCenter() })
  } catch {
    return // 结构还没改完整，等下一次
  }
  const kept = new Map(state.graph.nodes.map((node) => [node.id, node.result]))
  for (const node of restored.graph.nodes) {
    if ((runnable(node) || node.kind === 'timer') && kept.get(node.id)) node.result = kept.get(node.id)
  }
  state.evolved = new Set([...nodeKeys(restored.graph)].filter(([id, key]) => baseline.get(id) !== key).map(([id]) => id))
  state.graph = restored.graph
  state.selection = new Set()
  loadExtensions() // pi 可能刚写了一个新扩展，端口要照它的清单画
}

function closeEvolveWindow() {
  state.evolved = new Set()
  notify()
}

// pi 改的是盘上的文件：从盘上重开，撤销栈也清掉（它记的是改之前的图）
async function afterEvolve() {
  try {
    await loadWorkspace(state.workspace)
    resetHistory()
    state.evolved = new Set([...nodeKeys(state.graph)].filter(([id, key]) => baseline.get(id) !== key).map(([id]) => id))
    notify()
  } catch (error) {
    showMessage(`进化完了，但重开工作文件夹失败：${error.message}`)
    return
  }
  showMessage(state.evolve?.last?.message ?? '进化结束')
}

// 定时器的一次触发（含跳过）落在定时器节点上：上次什么时候响的、是跑了还是跳了。
function applyTrigger(hit) {
  update((draft) => {
    const node = findNode(draft.graph, hit.timerId)
    if (!node || node.kind !== 'timer') return
    node.result = { at: hit.at, skipped: hit.kind === 'skipped', note: hit.note ?? '' }
  })
}

// 按 NDJSON 行读一次运行的事件流，边收边摊到界面上。
async function watchRun(runId) {
  if (seenRuns.has(runId)) return // 手动跑的、轮询发现的，只订阅一次
  seenRuns.add(runId)
  const controller = new AbortController()
  aborts.set(runId, controller)
  try {
    const response = await fetch(`/api/run/${runId}/events`, { signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`订阅失败（${response.status}）`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // JSON 里的换行是转义过的，按真换行切行是安全的
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (line.trim()) applyRunEvent(runId, JSON.parse(line))
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) showMessage(`运行的订阅断了：${error.message}`)
    seenRuns.delete(runId) // 订阅断了就让它下一圈再试：链可能还在后端跑着
  } finally {
    aborts.delete(runId)
    startedHere.delete(runId)
    // 流断了但没收到 end：把这次运行留在节点上的「运行中」收干净
    for (const id of state.runs.get(runId)?.nodes ?? []) state.running.delete(id)
    state.runs.delete(runId)
    stopTicking()
    update(() => {})
  }
}

// 后端的一件件事摊到界面上：起跑、这一步开跑、来了一块输出、这一步跑完、没走到的那些、整次结束。
function applyRunEvent(runId, event) {
  if (event.t === 'run') {
    state.runs.set(runId, { mode: event.mode, nodeId: event.nodeId, startedAt: event.startedAt, nodes: new Set([event.nodeId]) })
    update(() => {})
    return
  }
  if (event.t === 'step') {
    state.runs.get(runId)?.nodes.add(event.nodeId)
    state.running.set(event.nodeId, event.startedAt)
    startTicking()
    update((draft) => {
      const node = findNode(draft.graph, event.nodeId)
      if (!node) return // 跑起来之前它可能已经被删了
      node.result = null // 上次输出先清掉，节点上只留命令，输出从头攒
      node.live = ''
      node.liveLog = ''
      node.skipped = false
    })
    return
  }
  if (event.t === 'chunk') {
    const node = findNode(state.graph, event.nodeId)
    // 诊断（stderr）和值（stdout）分开攒：节点正文优先显示诊断，值仍在缓存文件里等着下游
    if (node) {
      if (event.stream === 'log') node.liveLog = `${node.liveLog ?? ''}${event.data}`
      else node.live = `${node.live ?? ''}${event.data}`
    }
    repaint()
    return
  }
  if (event.t === 'done') {
    state.running.delete(event.nodeId)
    stopTicking()
    update((draft) => {
      const node = findNode(draft.graph, event.nodeId)
      // 跑的时候节点可能已经被删了或被撤销掉了
      if (node) {
        node.result = event.result // 裸输出进缓存文件、元信息进存档
        node.live = ''
        node.liveLog = ''
      }
      for (const item of event.texts ?? []) setNodeText(draft.graph, item.nodeId, item.text)
    })
    return
  }
  if (event.t === 'skipped') {
    markSkipped(event.ids ?? [])
    return
  }
  if (event.t === 'end') {
    const run = state.runs.get(runId)
    for (const id of run?.nodes ?? []) state.running.delete(id)
    state.runs.delete(runId)
    stopTicking()
    // 只有自己发起的才报结束语：定时器一秒一条，报了就是在工具条上刷屏
    if (startedHere.delete(runId)) showMessage(event.message)
    update(() => {})
    refreshSlots()
  }
}

// 输出一块块来：重绘按帧合并，别让快命令把渲染拖住
let waitingFrame = false
function repaint() {
  if (waitingFrame) return
  waitingFrame = true
  requestAnimationFrame(() => {
    waitingFrame = false
    update(() => {})
  })
}

// 设置窗口：全局配置和存档配置都在里面改，值由后端存、存档自己落盘。
async function openSettings() {
  try {
    const saved = await askSettings({
      current: { machine, canvas },
      hasWorkspace: Boolean(state.workspace),
      onImported: loadExtensions, // 拷进来的插件要马上出现在右键菜单里
    })
    if (!saved) return
    applyMachine(saved.machine) // 跟机器走的：后端刚存下来，以后每次跑命令它自己去读
    applyCanvas(saved.canvas) // 跟画布走的：收进内存，下面一次落盘就写进存档
    scheduleSave()
    notify()
    showMessage('设置已保存')
  } catch (error) {
    showMessage(`读设置失败：${error.message}`)
  }
}

// 面板：声明进存档（不进撤销），值立刻写到 .mican/board/<名字>.md。
function changeBoard(next, disk) {
  applyBoard(next)
  scheduleSave()
  notify()
  if (!disk || !state.workspace) return
  const job = disk.write !== undefined
    ? api('/api/board', { action: 'write', name: disk.write, value: disk.value ?? '' }).then(() => {
      state.slots[disk.write] = disk.value ?? ''
    })
    : disk.delete
      ? api('/api/board', { action: 'delete', name: disk.delete }).then(() => {
        delete state.slots[disk.delete]
      })
      : disk.rename
        ? api('/api/board', { action: 'rename', name: disk.rename, to: disk.to }).then(() => {
          if (state.slots[disk.rename] !== undefined) {
            state.slots[disk.to] = state.slots[disk.rename]
            delete state.slots[disk.rename]
          }
          update((draft) => {
            for (const node of draft.graph.nodes) {
              if ((node.kind === 'get' || node.kind === 'set') && node.slot === disk.rename) node.slot = disk.to
            }
          })
        })
        : Promise.resolve()
  job.then(() => notify()).catch((error) => showMessage(`面板没写上：${error.message}`))
}

async function refreshSlots() {
  if (!state.workspace) return
  try {
    state.slots = (await api('/api/board', { action: 'read' })).values ?? {}
    notify()
  } catch {
    // 读不到就留着内存里这份
  }
}

// 单个节点的运行目录：设了就覆盖画布那一层，清空就退回它；也可以一步点名要工作文件夹。
async function setRunDir(id) {
  const node = findNode(state.graph, id)
  if (!node || node.kind !== 'command') return
  const dir = await askRunDir({
    initial: node.cwd ?? '',
    hint: `相对工作文件夹的路径（“.” 就是工作文件夹），或这台机器上的绝对路径；留空就跟随这份画布的运行目录（${canvas.cwd || '工作文件夹'}）`,
    placeholder: '相对工作文件夹，如 . 或 ./sub；或绝对路径',
    quick: [
      { label: '工作文件夹', value: '.', hint: state.workspace ?? '还没打开工作文件夹' },
      { label: '跟随画布', value: '', hint: canvas.cwd || '画布没设，就是工作文件夹' },
    ],
  })
  if (dir === null || dir === (node.cwd ?? '')) return
  update((draft) => setNodeCwd(draft.graph, id, dir))
}

// 没走到的那些在节点上留一句话，不然分不清「没走」和「走了是空的」。
// 这不是画布状态（不进存档），所以不走历史也不排落盘。
function markSkipped(ids) {
  if (!ids.length) return
  update((draft) => {
    for (const id of ids) {
      const node = findNode(draft.graph, id)
      if (node) node.skipped = true
    }
  })
}

// ---- 视图 / 存档 ----

function resetZoom() {
  const viewport = document.getElementById('viewport')
  update((draft) => {
    draft.view = zoomAt(draft.view, viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / draft.view.scale)
  })
}

function applyGraph(snapshot) {
  const { nodes, edges, layout, texts } = JSON.parse(snapshot)
  // 运行结果不是被编辑的结构，撤销不该顺手把它扫掉（那会连带删掉磁盘上的缓存文件），按 id 接回来
  const kept = new Map(state.graph.nodes.map((node) => [node.id, node.result]))
  const restored = deserialize({ canvas: { version: FORMAT_VERSION, nodes, edges }, layout: { nodes: layout }, texts }).graph
  for (const node of restored.nodes) {
    // 定时器的触发记录也不是被编辑的结构，按 id 接回来
    if ((runnable(node) || node.kind === 'timer') && kept.get(node.id)) node.result = kept.get(node.id)
  }
  state.graph = restored
  state.selection = new Set()
  lastRecord = 0 // 下一次改动重新开一步
  scheduleSave()
  notify()
}

function undo() {
  const snapshot = undoHistory(history, graphSnapshot())
  if (snapshot !== null) applyGraph(snapshot)
}

function redo() {
  const snapshot = redoHistory(history, graphSnapshot())
  if (snapshot !== null) applyGraph(snapshot)
}

// ---- 键盘 ----

window.addEventListener('keydown', (event) => {
  if (document.activeElement !== document.body) return // 编辑态不抢键
  if (state.evolve?.active) return // 进化期间画布只读
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (mod && event.key.toLowerCase() === 'c') {
    // 正文里选着字：这一下是抄那段字，别抢走
    const picked = window.getSelection()
    if (picked && !picked.isCollapsed) return
    if (copySelection()) event.preventDefault()
    return
  }
  if (mod && event.key.toLowerCase() === 'v') {
    if (!clipboard) return
    event.preventDefault()
    pasteSelection()
    return
  }
  if (mod && event.key.toLowerCase() === 'd') {
    if (!duplicateSelection()) return
    event.preventDefault()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    // 正文里选着字的时候，这一下是冲那段字来的，不是冲节点 —— 别删掉用户正要抄的东西
    const picked = window.getSelection()
    if (picked && !picked.isCollapsed) return
    event.preventDefault()
    deleteSelection()
  }
})

// 不拦关闭：改动一结束就落盘了，没有「未保存」这个状态可以警告（ADR-0003）

// ---- 装配 ----

mountCanvas({
  getView: () => state.view,
  setView: (view) => update((draft) => { draft.view = view }),
  subscribe,
  onBackgroundPress: clearSelection,
  onBackgroundDblClick: (world) => createNodeAt(world, 'text'),
  // 框选：世界坐标里跟框搭上边的节点与边都选中。按下时已经先把上一次的选择清掉了，
  // 所以这一趟是「以框为准」，不是往上加。
  // 节点比矩形，边比曲线（两边算的是同一根线）—— 框住一段就算，不要求整条都在框里。
  onMarquee: (box) =>
    update((draft) => {
      const ids = draft.graph.nodes.filter((node) => rectsOverlap(box, node)).map((node) => node.id)
      for (const edge of draft.graph.edges) {
        const from = findNode(draft.graph, edge.from)
        const to = findNode(draft.graph, edge.to)
        // 框选一条边：命中用的曲线必须跟画出来的是同一根，所以这里也算一遍它接在哪个端口上
        const toIndex = targetPortIndex(draft.graph, edge, state.extensions)
        const fromIndex = sourcePortIndex(draft.graph, edge, state.extensions)
        if (from && to && curveHitsBox(edgeCurve(from, to, edge.kind, toIndex, fromIndex), box)) ids.push(edge.id)
      }
      draft.selection = new Set(ids)
    }),
  onResetZoom: resetZoom,
})

const edges = mountEdges({ getState: () => state, update, onError: showMessage })
const nodes = mountNodes({
  getState: () => state,
  update,
  onConnectStart: edges.startConnection,
  onRunCommand,
  onRunChain,
  onNewCommandNode: (world) => createNodeAt(world, 'command'),
  onNewExtractNode: (world) => createNodeAt(world, 'extract'),
  onNewEntryNode: (world) => createNodeAt(world, 'entry'),
  onNewTimerNode: (world) => createNodeAt(world, 'timer'),
  // 扩展节点就是一个命令节点，只是命令从扩展那份清单里拼（ADR-0014）
  onNewExtensionNode: (world, extension) => createNodeAt(world, 'command', { extension }),
  onSetRunDir: setRunDir,
})
const toolbar = mountToolbar({ getState: () => state, actions: { saveAs, openWorkspace, resetZoom, openSettings, evolve: () => evolveWindow.toggle(), start: startFromEntries, stop: stopRunning } })
const evolveWindow = mountEvolveWindow({
  getState: () => state,
  actions: { evolve: startEvolve, undo: undoEvolve, restore: restoreEvolve },
  onClose: closeEvolveWindow,
})
const boardPanel = mountBoard({
  getState: () => state,
  onChange: changeBoard,
  onDropNode: (world, kind, slot) => createNodeAt(world, kind, { slot }),
})
// 设置要先读到（全局运行目录、启动要打开哪个工作文件夹都在里面），所以这几句串起来做
// 最后一句把后端还在跑的链接回来：页面关着的时候它可能已经跑起来了（ADR-0009）。
loadRecent()
  .then(loadSettings)
  .then(openStartupWorkspace)
  .then(pollLoop)

const hint = document.getElementById('hint')

subscribe((next) => {
  hint.classList.toggle('hidden', next.graph.nodes.length > 0)
})
subscribe(edges.render)
subscribe(nodes.render)
subscribe(toolbar.render)
subscribe(boardPanel.render)
subscribe(evolveWindow.render)
