// 图：节点与边的纯数据操作，不碰 DOM。

export const NODE_DEFAULT_W = 320
export const NODE_DEFAULT_H = 200
export const NODE_MIN_W = 160
export const NODE_MIN_H = 80

let seq = 0

export function newId(prefix) {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`
}

export function createGraph() {
  return { nodes: [], edges: [] }
}

export function createNode({ x = 0, y = 0, w = NODE_DEFAULT_W, h = NODE_DEFAULT_H, text = '' } = {}) {
  return { id: newId('n'), x, y, w, h, text }
}

export function findNode(graph, id) {
  return graph.nodes.find((node) => node.id === id) ?? null
}

// 删节点连带删掉挂在它身上的边，不允许存在悬空的边。
export function removeNode(graph, id) {
  graph.nodes = graph.nodes.filter((node) => node.id !== id)
  graph.edges = graph.edges.filter((edge) => edge.from !== id && edge.to !== id)
}

export function moveNode(graph, id, x, y) {
  const node = findNode(graph, id)
  if (!node) return
  node.x = x
  node.y = y
}

export function resizeNode(graph, id, w, h) {
  const node = findNode(graph, id)
  if (!node) return
  node.w = Math.max(NODE_MIN_W, w)
  node.h = Math.max(NODE_MIN_H, h)
}
