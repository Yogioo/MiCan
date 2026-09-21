// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import {
  NODE_DEFAULT_H,
  NODE_DEFAULT_W,
  createGraph,
  createNode,
  removeEdge,
  removeNode,
} from '../core/graph.mjs'
import { deserialize, serialize } from '../core/serialize.mjs'
import { createView, zoomAt } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountNodes } from './nodes.mjs'
import { mountToolbar } from './toolbar.mjs'

const STORAGE_KEY = 'mican'
const SAVE_DELAY = 400

export const state = {
  view: createView(),
  graph: createGraph(),
  selection: null,
  saveState: 'saved',
  message: '',
}

const subscribers = new Set()

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
}

function notify() {
  for (const fn of subscribers) fn(state)
}

export function update(mutate) {
  mutate(state)
  notify()
}

// 启动：先读本地存档，读不出来就按空白画布启动，不打扰用户。
try {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    const restored = deserialize(JSON.parse(raw))
    state.view = restored.view
    state.graph = restored.graph
  }
} catch (error) {
  console.warn('[mican] 本地存档读不出来，按空白画布启动：', error)
}

// 自动保存：改动防抖 400ms 落盘，关页面前补一次，避免最后一笔丢失。
let written = JSON.stringify(serialize(state))
let pending = null
let timer = null

function flush() {
  clearTimeout(timer)
  timer = null
  if (pending === null) return
  const payload = pending
  pending = null
  try {
    localStorage.setItem(STORAGE_KEY, payload)
    written = payload
    state.saveState = 'saved'
  } catch (error) {
    console.warn('[mican] 保存失败：', error)
    return
  }
  queueMicrotask(notify)
}

function scheduleSave(next) {
  const payload = JSON.stringify(serialize(next))
  if (payload === written || payload === pending) return
  pending = payload
  if (state.saveState !== 'pending') {
    state.saveState = 'pending'
    queueMicrotask(notify) // 让状态点变黄，但不打断当前这轮分发
  }
  clearTimeout(timer)
  timer = setTimeout(flush, SAVE_DELAY)
}

window.addEventListener('pagehide', flush)

// 动作

function createNodeAt(world) {
  const node = createNode({
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

function resetZoom() {
  const viewport = document.getElementById('viewport')
  update((draft) => {
    draft.view = zoomAt(draft.view, viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / draft.view.scale)
  })
}

function exportJson() {
  const blob = new Blob([JSON.stringify(serialize(state), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `mican-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  link.click()
  URL.revokeObjectURL(url)
}

// 导入用的隐藏 file input：常驻 DOM，方便复用
const picker = document.createElement('input')
picker.id = 'import-picker'
picker.type = 'file'
picker.accept = '.json,application/json'
picker.hidden = true
picker.addEventListener('change', onPickFile)
document.body.append(picker)

function importJson() {
  picker.value = '' // 同一个文件也能再选一次
  picker.click()
}

async function onPickFile() {
  const file = picker.files?.[0]
  if (!file) return
  try {
    const restored = deserialize(JSON.parse(await file.text()))
    update((draft) => {
      draft.view = restored.view
      draft.graph = restored.graph
      draft.selection = null
      draft.message = ''
    })
  } catch (error) {
    showMessage(`导入失败：${error.message}`)
  }
}

let messageTimer = null

function showMessage(text) {
  update((draft) => {
    draft.message = text
  })
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => update((draft) => { draft.message = '' }), 4000)
}

// 键盘

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return
  if (document.activeElement !== document.body) return // 编辑态不抢键
  event.preventDefault()
  deleteSelection()
})

mountCanvas({
  getView: () => state.view,
  setView: (view) => update((draft) => { draft.view = view }),
  subscribe,
  onBackgroundPress: clearSelection,
  onBackgroundDblClick: createNodeAt,
  onResetZoom: resetZoom,
})

const edges = mountEdges({ getState: () => state, update })
const nodes = mountNodes({ getState: () => state, update, onConnectStart: edges.startConnection })
const toolbar = mountToolbar({ getState: () => state, actions: { exportJson, importJson, resetZoom } })

subscribe(edges.render)
subscribe(nodes.render)
subscribe(toolbar.render)
subscribe(scheduleSave)
