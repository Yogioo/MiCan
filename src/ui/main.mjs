// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import {
  createGraph,
  createNode,
  findNode,
  removeEdge,
  removeNode,
  runnable,
  setNodeCwd,
  setNodeEntry,
  setNodeText,
} from '../core/graph.mjs'
import { FORMAT_VERSION, deserialize, serialize } from '../core/serialize.mjs'
import { applyCanvas, applyMachine, canvas, machine } from '../core/settings.mjs'
import { createHistory, push, redo as redoHistory, undo as undoHistory } from '../core/history.mjs'
import { createView, zoomAt } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountNodes } from './nodes.mjs'
import { askSettings } from './settings-dialog.mjs'
import { mountToolbar } from './toolbar.mjs'
import { askRunDir, askWorkspace } from './workspace-dialog.mjs'

export const state = {
  view: createView(),
  graph: createGraph(),
  selection: null,
  workspace: null, // 工作文件夹的绝对路径，未打开时为 null
  // 跟机器走的那些值（命令行、超时、界面手感）不住在这儿：它们住在 core/settings.mjs，现读现用；
  // 运行目录属于画布，在 canvas.cwd
  running: new Map(), // 运行中的命令节点：id -> 开跑时间。只活在内存里，不进存档
  // 后端在跑的每一次运行：runId -> { mode, nodeId, startedAt, nodes }。链也是其中一条，
  // 它不由某个进程代表（两步之间的空档也在跑），所以右下角那个停止按钮看的是这张表。
  runs: new Map(),
  saving: false, // 有一次落盘还在路上
  message: '',
}

const subscribers = new Set()

// 撤销：只认结构变化，连拖时快速连发的改动合并成一步。
// 合并窗口多久算「一次改动」在设置里（machine.undoMergeMs）。
const history = createHistory()
let lastRecord = 0

function graphSnapshot() {
  const { nodes, edges } = serialize(state)
  return JSON.stringify({ nodes, edges })
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
  // 缓存文件就是节点的值：裸输出写文件，元信息在存档的 results 里。
  // 命令节点和提取节点都一样，所以过滤按「会不会跑」来，不按 kind 写死。
  const cache = state.graph.nodes
    .filter((node) => runnable(node) && node.result)
    .map((node) => ({ id: node.id, content: node.result.output ?? '' }))
  return { canvas: serialize(state), docs, cache }
}

function scheduleSave() {
  if (!state.workspace) return
  clearTimeout(scheduled)
  scheduled = setTimeout(saveNow, machine.autosaveMs)
}

// 立刻写一次。命令跑完、链路每一步之后都靠它 —— 缓存文件得马上在盘上。
function saveNow() {
  clearTimeout(scheduled)
  scheduled = null
  if (!state.workspace) return Promise.resolve()
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

// 打开 / 另存为之后，画布与磁盘就是一致的，所以直接把状态按上去，不排落盘。
// next 就是接下来要用的那份 { graph, view }：打开时是读出来的，另存为时就是手上这份。
function adoptWorkspace(root, next) {
  clearTimeout(scheduled)
  scheduled = null
  state.workspace = root
  state.graph = next.graph
  state.view = next.view
  state.selection = null
  notify()
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
  const restored = response.canvas ? deserialize(response.canvas) : null
  const cache = response.cache ?? {}
  // 元信息在存档里、裸输出在缓存文件里，两份合起来才是一个完整的结果
  if (restored) {
    for (const node of restored.graph.nodes) if (node.result) node.result.output = cache[node.id] ?? ''
    applyCanvas(restored.settings) // 跟这份画布走的设置（步数上限这类）跟着存档换
  }
  adoptWorkspace(response.root, restored ?? { graph: createGraph(), view: state.view })
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

function createNodeAt(world, kind) {
  const node = createNode({
    kind,
    x: world.x - machine.nodeDefaultW / 2,
    y: world.y - machine.nodeDefaultH / 2,
  })
  update((draft) => {
    draft.graph.nodes.push(node)
    draft.selection = { kind: 'node', id: node.id }
  })
}

function deleteSelection() {
  const { selection } = state
  if (!selection) return
  update((draft) => {
    if (selection.kind === 'node') removeNode(draft.graph, selection.id)
    else removeEdge(draft.graph, selection.id)
    draft.selection = null
  })
}

function clearSelection() {
  if (!state.selection) return
  update((draft) => {
    draft.selection = null
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
    watchRun(runId)
  } catch (error) {
    showMessage(error.message)
  }
}

const onRunCommand = (id) => startRun('node', id)
const onRunChain = (id) => startRun('chain', id)

// 网页重开时后端可能还有链在走（页面关着也跑）—— 把在跑的都接上。
async function resumeRuns() {
  try {
    for (const item of (await api('/api/runs', {})).items ?? []) watchRun(item.runId)
  } catch {
    // 读不到就当没有在跑的
  }
}

// 按 NDJSON 行读一次运行的事件流，边收边摊到界面上。
async function watchRun(runId) {
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
  } finally {
    aborts.delete(runId)
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
      node.skipped = false
    })
    return
  }
  if (event.t === 'chunk') {
    const node = findNode(state.graph, event.nodeId)
    if (node) node.live = `${node.live ?? ''}${event.data}`
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
      }
      for (const item of event.texts ?? []) setNodeText(draft.graph, item.nodeId, item.text)
    })
    scheduleSave() // 后端补进存档的那几个键，也从这边过一道，别只在内存里
    return
  }
  if (event.t === 'skipped') {
    markSkipped(event.ids ?? [])
    return
  }
  if (event.t === 'end') {
    state.runs.delete(runId)
    stopTicking()
    showMessage(event.message)
    update(() => {})
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
    const saved = await askSettings({ current: { machine, canvas } })
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
  const { nodes, edges } = JSON.parse(snapshot)
  // 运行结果不是被编辑的结构，撤销不该顺手把它扫掉（那会连带删掉磁盘上的缓存文件），按 id 接回来
  const kept = new Map(state.graph.nodes.map((node) => [node.id, node.result]))
  const restored = deserialize({ version: FORMAT_VERSION, nodes, edges }).graph
  for (const node of restored.nodes) {
    if (runnable(node) && kept.get(node.id)) node.result = kept.get(node.id)
  }
  state.graph = restored
  state.selection = null
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
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
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
  onResetZoom: resetZoom,
})

const edges = mountEdges({ getState: () => state, update, onError: showMessage })
const nodes = mountNodes({
  getState: () => state,
  update,
  onConnectStart: edges.startConnection,
  onRunCommand,
  onRunChain,
  // 菜单里只在「没有执行入边」的节点上给这一项，所以 setNodeEntry 不会拒绝
  onToggleEntry: (id) => update((draft) => setNodeEntry(draft.graph, id, !findNode(draft.graph, id)?.entry)),
  onNewCommandNode: (world) => createNodeAt(world, 'command'),
  onNewExtractNode: (world) => createNodeAt(world, 'extract'),
  onSetRunDir: setRunDir,
})
const toolbar = mountToolbar({ getState: () => state, actions: { saveAs, openWorkspace, resetZoom, openSettings, stop: stopRunning } })
// 设置要先读到（全局运行目录、启动要打开哪个工作文件夹都在里面），所以这几句串起来做
// 最后一句把后端还在跑的链接回来：页面关着的时候它可能已经跑起来了（ADR-0009）。
loadRecent()
  .then(loadSettings)
  .then(openStartupWorkspace)
  .then(resumeRuns)

const hint = document.getElementById('hint')

subscribe((next) => {
  hint.classList.toggle('hidden', next.graph.nodes.length > 0)
})
subscribe(edges.render)
subscribe(nodes.render)
subscribe(toolbar.render)
