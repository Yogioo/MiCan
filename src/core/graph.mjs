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

export function createNode({ kind = 'text', x = 0, y = 0, w = NODE_DEFAULT_W, h = NODE_DEFAULT_H, text = '', command = '', cwd = '', file = '' } = {}) {
  const id = newId('n')
  if (kind === 'command') return { id, kind, x, y, w, h, command, cwd }
  return { id, kind: 'text', x, y, w, h, file: file || `docs/${id}.md`, text }
}

// 文件名的唯一入口：只留一个文件名，补上 .md，其余（路径分隔符、前导点）挡掉。
export function normalizeFileName(name) {
  const base = String(name).trim().replace(/[\\/]/g, '').replace(/^[.\s]+/, '')
  if (!base) return null
  return /\.md$/i.test(base) ? base : `${base}.md`
}

export function setNodeFile(graph, id, file) {
  const node = findNode(graph, id)
  if (!node) return
  node.file = file
}

export function setNodeCommand(graph, id, command) {
  const node = findNode(graph, id)
  if (!node) return
  node.command = command
}

// 运行目录：空串表示跟着上一层（全局，再到工作文件夹）；相对路径相对工作文件夹（“.” 就是工作文件夹），
// 其余按本机绝对路径算。
export function setNodeCwd(graph, id, cwd) {
  const node = findNode(graph, id)
  if (!node) return
  node.cwd = cwd
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

export function setNodeText(graph, id, text) {
  const node = findNode(graph, id)
  if (!node) return
  node.text = text
}

// ---- 边 ----

export function findEdge(graph, id) {
  return graph.edges.find((edge) => edge.id === id) ?? null
}

// 建边：不允许自连，也不重复建同向的边；建不出来返回 null。
export function addEdge(graph, from, to) {
  if (!from || !to || from === to) return null
  if (!findNode(graph, from) || !findNode(graph, to)) return null
  if (graph.edges.some((edge) => edge.from === from && edge.to === to)) return null
  const edge = { id: newId('e'), from, to, label: '' }
  graph.edges.push(edge)
  return edge
}

export function removeEdge(graph, id) {
  graph.edges = graph.edges.filter((edge) => edge.id !== id)
}

export function setEdgeLabel(graph, id, label) {
  const edge = findEdge(graph, id)
  if (!edge) return
  edge.label = label
}
