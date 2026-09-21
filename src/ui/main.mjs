// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import {
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  createGraph,
  createNode,
  findNode,
  removeEdge,
  removeNode,
  setNodeText,
} from '../core/graph.mjs'
import { FORMAT_VERSION, deserialize, serialize } from '../core/serialize.mjs'
import { createHistory, push, redo as redoHistory, undo as undoHistory } from '../core/history.mjs'
import { createView, zoomAt } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountNodes } from './nodes.mjs'
import { mountToolbar } from './toolbar.mjs'

export const state = {
  view: createView(),
  graph: createGraph(),
  selection: null,
  workspace: null, // 工作文件夹的绝对路径，未打开时为 null
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

function confirmDiscard() {
  return !state.dirty || window.confirm('有未保存的改动，继续会丢掉它们。继续吗？')
}

function markSaved(text) {
  savedSnapshot = graphSnapshot()
  showMessage(text)
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
  if (!confirmDiscard()) return
  const input = window.prompt('新工作文件夹的绝对路径（不存在或为空）', '')
  if (!input) return
  try {
    const { root } = await api('/api/workspace', { path: input, mode: 'create' })
    update((draft) => {
      draft.workspace = root
    })
    savedFiles = new Set()
    await save()
  } catch (error) {
    showMessage(`另存为失败：${error.message}`)
  }
}

async function openWorkspace() {
  if (!confirmDiscard()) return
  const input = window.prompt('工作文件夹的绝对路径', state.workspace ?? '')
  if (!input) return
  try {
    const { root, canvas } = await api('/api/workspace', { path: input, mode: 'open' })
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
  } catch (error) {
    showMessage(`打开失败：${error.message}`)
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

async function runCommand(id) {
  const node = findNode(state.graph, id)
  if (!node || node.kind !== 'command') return
  if (!state.workspace) return showMessage('先保存或打开一个工作文件夹，命令才有地方跑')
  if (!node.command.trim()) return showMessage('这个命令节点还没有命令')

  const targets = state.graph.edges
    .filter((edge) => edge.from === id)
    .map((edge) => findNode(state.graph, edge.to))
    .filter((item) => item?.kind === 'text')

  showMessage(`运行中：${node.command.trim()}`)
  let result
  try {
    result = await api('/api/exec', { command: node.command })
  } catch (error) {
    return showMessage(`运行失败：${error.message}`)
  }

  const record = { ...result, at: Date.now() }
  update((draft) => {
    findNode(draft.graph, id).result = record // 运行结果不进存档，撤销后就没了
    if (!record.failed) for (const item of targets) setNodeText(draft.graph, item.id, record.output)
  })

  if (record.failed) showMessage(`退出码 ${record.code}，没有覆写下游文本节点`)
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
})
const toolbar = mountToolbar({ getState: () => state, actions: { save, saveAs, openWorkspace, resetZoom } })

const hint = document.getElementById('hint')

subscribe((next) => {
  hint.classList.toggle('hidden', next.graph.nodes.length > 0)
})
subscribe(edges.render)
subscribe(nodes.render)
subscribe(toolbar.render)
