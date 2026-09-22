// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import {
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  createGraph,
  createNode,
  findNode,
  removeEdge,
  removeNode,
  setNodeCwd,
  setNodeText,
} from '../core/graph.mjs'
import { FORMAT_VERSION, deserialize, serialize } from '../core/serialize.mjs'
import { applyVars, collectVars } from '../core/vars.mjs'
import { createHistory, push, redo as redoHistory, undo as undoHistory } from '../core/history.mjs'
import { createView, zoomAt } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountNodes } from './nodes.mjs'
import { mountToolbar } from './toolbar.mjs'
import { askDiscard, askRunDir, askWorkspace } from './workspace-dialog.mjs'

export const state = {
  view: createView(),
  graph: createGraph(),
  selection: null,
  workspace: null, // 工作文件夹的绝对路径，未打开时为 null
  settings: { cwd: '' }, // 全局运行目录，存在用户目录里，不进存档；空串 = 跟随工作文件夹
  running: new Map(), // 运行中的命令节点：id -> 开跑时间。只活在内存里，不进存档
  dirty: false,
  message: '',
}

const subscribers = new Set()

// 撤销：只认结构变化，连拖时快速连发的改动合并成一步。
const history = createHistory()
const COALESCE_MS = 500
let lastRecord = 0

function graphSnapshot() {
  const { nodes, edges } = serialize(state)
  return JSON.stringify({ nodes, edges })
}

// 磁盘是「上次保存」的快照：这两个变量就是那条基准线。
let savedSnapshot = graphSnapshot()
let savedFiles = new Set()

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
}

function notify() {
  state.dirty = graphSnapshot() !== savedSnapshot
  for (const fn of subscribers) fn(state)
}

export function update(mutate) {
  const before = graphSnapshot()
  mutate(state)
  if (graphSnapshot() !== before) {
    const now = Date.now()
    if (now - lastRecord > COALESCE_MS) push(history, before)
    lastRecord = now
  }
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
  messageTimer = setTimeout(() => update((draft) => { draft.message = '' }), 4000)
}

// ---- 保存 / 另存为 / 打开 ----

// 最近打开过的文件夹，由后端记着（换浏览器、换端口都还在）。
let recent = []

async function loadRecent() {
  try {
    recent = (await api('/api/recent', {})).items ?? []
  } catch {
    recent = []
  }
}

// 全局运行目录也由后端记着，跟这台机器走，不进画布存档。
async function loadSettings() {
  try {
    const data = await api('/api/settings', {})
    update((draft) => { draft.settings = { cwd: typeof data.cwd === 'string' ? data.cwd : '' } })
  } catch {
    // 读不到就当没设
  }
}

function confirmDiscard() {
  return !state.dirty || askDiscard('有未保存的改动，继续会丢掉它们。')
}

function markSaved(text) {
  savedSnapshot = graphSnapshot()
  showMessage(text)
}

// 后端把这次的文件夹排到了历史最前面，前端跟着换一份。
function remember(response) {
  recent = response.recent ?? recent
}

async function save() {
  if (!state.workspace) return saveAs()
  const docs = state.graph.nodes
    .filter((node) => node.kind === 'text')
    .map((node) => ({ file: node.file, content: node.text }))
  const written = new Set(docs.map((doc) => doc.file))
  const remove = [...savedFiles].filter((file) => !written.has(file))
  try {
    await api('/api/save', { canvas: serialize(state), docs, remove })
  } catch (error) {
    return showMessage(`保存失败：${error.message}`)
  }
  savedFiles = written
  markSaved('已保存')
}

async function saveAs() {
  if (!(await confirmDiscard())) return
  let initial = ''
  let error = ''
  for (;;) {
    const input = await askWorkspace({ mode: 'create', initial, recent, error })
    if (!input) return
    try {
      const response = await api('/api/workspace', { path: input, mode: 'create' })
      remember(response)
      update((draft) => {
        draft.workspace = response.root
      })
      savedFiles = new Set()
      await save()
      return
    } catch (failure) {
      initial = input // 弹窗重新开，错误写在里面，路径不用重打
      error = `另存为失败：${failure.message}`
    }
  }
}

async function openWorkspace() {
  if (!(await confirmDiscard())) return
  let initial = state.workspace ?? recent[0] ?? ''
  let error = ''
  for (;;) {
    const input = await askWorkspace({ mode: 'open', initial, recent, error })
    if (!input) return
    try {
      const { root, canvas, ...rest } = await api('/api/workspace', { path: input, mode: 'open' })
      remember(rest)
      const restored = canvas ? deserialize(canvas) : null
      update((draft) => {
        draft.workspace = root
        draft.graph = restored ? restored.graph : createGraph()
        draft.view = restored ? restored.view : draft.view
        draft.selection = null
      })
      savedFiles = new Set(restored ? restored.graph.nodes.filter((node) => node.kind === 'text').map((node) => node.file) : [])
      resetHistory()
      markSaved(restored ? '已打开' : '文件夹里没有画布存档，按空白画布打开')
      return
    } catch (failure) {
      initial = input
      error = `打开失败：${failure.message}`
    }
  }
}

// ---- 节点 ----

function createNodeAt(world, kind) {
  const node = createNode({
    kind,
    x: world.x - NODE_DEFAULT_W / 2,
    y: world.y - NODE_DEFAULT_H / 2,
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

// 按 NDJSON 行读 /api/exec 的输出流，边收边回调；返回最后那行终止信息。
async function streamExec(command, cwd, onChunk) {
  const response = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, cwd }),
  })
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? `请求失败（${response.status}）`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let exit = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // JSON 里的换行是转义过的，按真换行切行是安全的
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.type === 'chunk') onChunk(message.data)
      else if (message.type === 'exit') exit = message
    }
  }
  return exit ?? { code: 1, failed: true, output: '连接断了，命令没有回来' }
}

// 命令的运行目录：节点自己设了就用节点的（覆盖全局），没设就跟全局，都没有就是工作文件夹。
function runDirOf(node) {
  return node.cwd || state.settings.cwd || ''
}

// 全局运行目录：所有命令节点的默认值，节点自己设了就不看它。
async function setGlobalRunDir() {
  const current = state.settings.cwd
  const dir = await askRunDir({ initial: current, hint: '所有命令节点的默认运行目录；留空就用工作文件夹' })
  if (dir === null || dir === current) return
  try {
    const data = await api('/api/settings', { cwd: dir })
    update((draft) => { draft.settings = { cwd: data.cwd ?? '' } })
    showMessage(data.cwd ? `全局运行目录：${data.cwd}` : '全局运行目录：跟随工作文件夹')
  } catch (error) {
    showMessage(`设置失败：${error.message}`)
  }
}

// 单个节点的运行目录：设了就覆盖全局，清空就退回全局。
async function setRunDir(id) {
  const node = findNode(state.graph, id)
  if (!node || node.kind !== 'command') return
  const dir = await askRunDir({
    initial: node.cwd ?? '',
    hint: `命令在这台机器上的绝对路径；留空就跟随全局（${state.settings.cwd || '工作文件夹'}）`,
  })
  if (dir === null || dir === (node.cwd ?? '')) return
  update((draft) => setNodeCwd(draft.graph, id, dir))
}

async function runCommand(id) {
  const node = findNode(state.graph, id)
  if (!node || node.kind !== 'command') return
  if (!state.workspace) return showMessage('先保存或打开一个工作文件夹，命令才有地方跑')
  if (!node.command.trim()) return showMessage('这个命令节点还没有命令')
  if (state.running.has(id)) return showMessage('这个命令还在跑，等它结束')

  // 变量注入只改这一次要跑的命令，命令节点上的模板不动
  const { vars, errors } = collectVars(state.graph, id)
  const injected = applyVars(node.command, vars)
  const missing = [...new Set(injected.missing)]
  if (errors.length || missing.length) {
    if (missing.length) errors.push(`{{${missing.join('}}、{{')}}} 没有对应的入边`)
    return showMessage(`变量没对上：${errors.join('；')}`)
  }
  const command = injected.command

  const targets = state.graph.edges
    .filter((edge) => edge.from === id)
    .map((edge) => findNode(state.graph, edge.to))
    .filter((item) => item?.kind === 'text')

  const runDir = runDirOf(node)
  const startedAt = Date.now()
  showMessage(`运行中：${command.trim()}${runDir ? `（在 ${runDir}）` : ''}`)
  state.running.set(id, startedAt)
  startTicking()
  update((draft) => {
    const target = findNode(draft.graph, id)
    target.result = null // 上次输出先清掉，节点上只留命令，输出从头攒
    target.live = ''
  })

  // 输出一块块来：先攒进 live，重绘按帧合并，别让快命令把渲染拖住
  let output = ''
  let waitingFrame = false
  const onChunk = (text) => {
    output += text
    const target = findNode(state.graph, id)
    if (target) target.live = output
    if (waitingFrame) return
    waitingFrame = true
    requestAnimationFrame(() => {
      waitingFrame = false
      update(() => {})
    })
  }

  let record
  try {
    record = await streamExec(command, runDir, onChunk)
  } catch (error) {
    record = { code: 1, failed: true, output: error.message }
  }

  state.running.delete(id)
  stopTicking()

  const text = output || record.output || ''
  const result = {
    code: record.code,
    failed: Boolean(record.failed),
    timedOut: Boolean(record.timedOut),
    truncated: Boolean(record.truncated),
    output: text,
    command, // 实际跑的命令（变量已替换），留着让节点上能回看
    at: Date.now(),
    elapsed: Date.now() - startedAt, // 跑完也留着，脚上照样看得到跑了多久
  }
  update((draft) => {
    const target = findNode(draft.graph, id)
    // 跑的时候节点可能已经被删了或被撤销掉了
    if (target) {
      target.result = result // 运行结果不进存档，撤销后就没了
      target.live = ''
    }
    if (!result.failed) for (const item of targets) setNodeText(draft.graph, item.id, text)
  })

  if (result.failed) showMessage(`退出码 ${result.code}，没有覆写下游文本节点`)
  else if (targets.length === 0) showMessage('没有下游文本节点，输出只显示在节点上')
  else showMessage(`输出已灌给 ${targets.length} 个下游文本节点，保存后落盘`)
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
  state.graph = deserialize({ version: FORMAT_VERSION, nodes, edges }).graph
  state.selection = null
  lastRecord = 0 // 下一次改动重新开一步
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

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return
  event.preventDefault()
  event.returnValue = ''
})

// ---- 装配 ----

mountCanvas({
  getView: () => state.view,
  setView: (view) => update((draft) => { draft.view = view }),
  subscribe,
  onBackgroundPress: clearSelection,
  onBackgroundDblClick: (world) => createNodeAt(world, 'text'),
  onResetZoom: resetZoom,
})

const edges = mountEdges({ getState: () => state, update })
const nodes = mountNodes({
  getState: () => state,
  update,
  onConnectStart: edges.startConnection,
  onRunCommand: runCommand,
  onNewCommandNode: (world) => createNodeAt(world, 'command'),
  onSetRunDir: setRunDir,
})
const toolbar = mountToolbar({ getState: () => state, actions: { save, saveAs, openWorkspace, resetZoom, setGlobalRunDir } })
loadRecent()
loadSettings()

const hint = document.getElementById('hint')

subscribe((next) => {
  hint.classList.toggle('hidden', next.graph.nodes.length > 0)
})
subscribe(edges.render)
subscribe(nodes.render)
subscribe(toolbar.render)
