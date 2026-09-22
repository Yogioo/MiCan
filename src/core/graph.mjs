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

export function createNode({ kind = 'text', x = 0, y = 0, w = NODE_DEFAULT_W, h = NODE_DEFAULT_H, text = '', command = '', cwd = '', file = '', entry = false } = {}) {
  const id = newId('n')
  if (kind === 'command') return { id, kind, x, y, w, h, command, cwd, entry }
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

// 边的两族：执行边只表达先后、不携带数据；数据边携带一份文本。
// 唯一区别就在 kind 上，别的规则（自连、重复）两族共用。
export function findEdge(graph, id) {
  return graph.edges.find((edge) => edge.id === id) ?? null
}

const pick = (graph, id, field, kind) =>
  graph.edges.filter((edge) => edge.kind === kind && edge[field] === id)

// 执行边在两头都是单连接，所以这几个只需要找第一条。
export function execIn(graph, id) {
  return pick(graph, id, 'to', 'exec')[0] ?? null
}

export function execOut(graph, id) {
  return pick(graph, id, 'from', 'exec')[0] ?? null
}

export function dataInto(graph, id) {
  return pick(graph, id, 'to', 'data')
}

export function dataOut(graph, id) {
  return pick(graph, id, 'from', 'data')
}

// 顺着执行边能不能从 start 走到 target。执行边两头单连接，所以这是一条直线。
function reaches(graph, start, target) {
  const seen = new Set()
  let cursor = start
  while (cursor && !seen.has(cursor)) {
    if (cursor === target) return true
    seen.add(cursor)
    cursor = execOut(graph, cursor)?.to ?? null
  }
  return false
}

// 这条边能不能建：能就返回 null，不能就返回一句话当理由（界面直接拿去提示）。
// 规则都集中在这里，建边的地方只管显示它，不自己判断。
export function connectProblem(graph, from, to, kind) {
  const source = findNode(graph, from)
  const target = findNode(graph, to)
  if (!source || !target) return '节点不在画布上'
  if (from === to) return '不能连到自己'
  // 同一对节点之间允许两族的边各一条（UE 里就是两根不同的线）：
  // 执行边定先后、数据边传值，链上两个都要有。
  if (graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind)) {
    return `这两点之间已经有一条${kind === 'exec' ? '执行边' : '数据边'}了`
  }
  if (kind === 'data') return null
  if (kind !== 'exec') return `不认识的边：${kind}`

  if (source.kind !== 'command' || target.kind !== 'command') return '执行边只能连两个命令节点'
  if (target.entry) return '它已经是入口了，起点头上接不了执行边'
  if (execIn(graph, to)) return '它的执行输入已经有一条边了'
  if (execOut(graph, from)) return '它的执行输出已经有一条边了'
  if (reaches(graph, to, from)) return '这么连会成一个环'
  return null
}

// 建边：先问 connectProblem，问不过就建不出来。
export function addEdge(graph, from, to, kind = 'data') {
  if (connectProblem(graph, from, to, kind)) return null
  const edge = { id: newId('e'), from, to, kind, label: '' }
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

// 入口：链的起点。有执行入边的节点当不了入口，否则「入口」就有两种意思了。
export function setNodeEntry(graph, id, entry) {
  const node = findNode(graph, id)
  if (!node || node.kind !== 'command') return false
  if (entry && execIn(graph, id)) return false
  node.entry = Boolean(entry)
  return true
}
