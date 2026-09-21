// 装配层：持有状态，把状态变更分发给各个界面模块，并定义应用动作。
import { NODE_DEFAULT_H, NODE_DEFAULT_W, createGraph, createNode, removeEdge, removeNode } from '../core/graph.mjs'
import { createView } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'
import { mountEdges } from './edges.mjs'
import { mountNodes } from './nodes.mjs'

export const state = {
  view: createView(),
  graph: createGraph(),
  selection: null,
}

const subscribers = new Set()

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
}

export function update(mutate) {
  mutate(state)
  for (const fn of subscribers) fn(state)
}

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
})

const edges = mountEdges({ getState: () => state, update })
const nodes = mountNodes({ getState: () => state, update, onConnectStart: edges.startConnection })
subscribe(edges.render)
subscribe(nodes.render)
