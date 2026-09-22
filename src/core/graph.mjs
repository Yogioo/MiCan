// 图：节点与边的纯数据操作，不碰 DOM。
import { machine } from './settings.mjs'

let seq = 0

export function newId(prefix) {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`
}

export function createGraph() {
  return { nodes: [], edges: [] }
}

export function createNode({ kind = 'text', x = 0, y = 0, w = machine.nodeDefaultW, h = machine.nodeDefaultH, text = '', command = '', cwd = '', file = '', entry = false, pick = '' } = {}) {
  const id = newId('n')
  if (kind === 'command') return { id, kind, x, y, w, h, command, cwd, entry }
  if (kind === 'extract') return { id, kind, x, y, w, h, pick }
  return { id, kind: 'text', x, y, w, h, file: file || `docs/${id}.md`, text }
}

// 会跑的节点：命令节点跑命令，提取节点算它的值。两者都能进链，都有值和缓存文件。
// 判断「是不是会跑的节点」都走这里，别到处写 kind === 'command'。
export const runnable = (node) => node?.kind === 'command' || node?.kind === 'extract'

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

// 取法：`json:isFull` 这样一段文本。解析是 pick.mjs 的事，这里只存。
export function setNodePick(graph, id, pick) {
  const node = findNode(graph, id)
  if (!node) return
  node.pick = pick
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
  node.w = Math.max(machine.nodeMinW, w)
  node.h = Math.max(machine.nodeMinH, h)
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

// 执行边在两头都不限根数：入边多根没有歧义（走路时光标只有一个），
// 出边多根靠标签分路。所以这两个都只需要找第一条 / 全部。
export function execIn(graph, id) {
  return pick(graph, id, 'to', 'exec')[0] ?? null
}

export function execOutAll(graph, id) {
  return pick(graph, id, 'from', 'exec')
}

export function dataInto(graph, id) {
  return pick(graph, id, 'to', 'data')
}

export function dataOut(graph, id) {
  return pick(graph, id, 'from', 'data')
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

  if (!runnable(source) || !runnable(target)) return '执行边只能连会跑的节点（命令节点或提取节点）'
  if (target.entry) return '它已经是入口了，起点头上接不了执行边'
  // 入边不限根数：走路时光标只有一个，「从哪儿来」永远是确定的，所以多根入边没有歧义。
  // 而且环的入口节点天生就有两根入边（外面一根、回边一根），卡着就画不出环。
  // 空标签是兜底，只能有一根，否则「不匹配时走到哪儿」就说不清了。
  // 出边可以成环（回来指向已经走过的节点），所以这里没有反环检查 —— 兜底靠运行时的步数上限。
  if (execOutAll(graph, from).some((edge) => !(edge.label ?? ''))) return '它的执行输出已经有一根兜底边了'
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

// 标签撞了能不能写：选路只认第一根匹配的，同一根出边上写重了就会静默走错。
export function labelProblem(graph, id, label) {
  const edge = findEdge(graph, id)
  if (!edge || edge.kind !== 'exec' || !label) return null
  const clash = execOutAll(graph, edge.from).some((item) => item.id !== id && (item.label ?? '') === label)
  return clash ? `这个节点已经有一根标签为「${label}」的执行出边了` : null
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
