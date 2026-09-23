// 图：节点与边的纯数据操作，不碰 DOM。
import { INPUT_ROW, NODE_FOOT_H } from './geometry.mjs'
import { DEFAULT_SCHEDULE } from './schedule.mjs'
import { machine } from './settings.mjs'
import { parseTokens } from './tokens.mjs'

let seq = 0

export function newId(prefix) {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`
}

export function createGraph() {
  return { nodes: [], edges: [] }
}

export function createNode({ kind = 'text', x = 0, y = 0, w = machine.nodeDefaultW, h = machine.nodeDefaultH, text = '', command = '', cwd = '', extension = '', file = '', pick = '', schedule = '' } = {}) {
  const id = newId('n')
  if (kind === 'command') return { id, kind, x, y, w, h, command, cwd, extension, consts: {} }
  if (kind === 'extract') return { id, kind, x, y, w, h, pick }
  if (kind === 'entry') return { id, kind, x, y, w, h }
  if (kind === 'timer') return { id, kind, x, y, w, h, schedule: schedule || DEFAULT_SCHEDULE }
  return { id, kind: 'text', x, y, w, h, file: file || `docs/${id}.md`, text }
}

// 会跑的节点：命令节点跑命令，提取节点算它的值。两者都能进链，都有值和缓存文件。
// 判断「是不是会跑的节点」都走这里，别到处写 kind === 'command'。
export const runnable = (node) => node?.kind === 'command' || node?.kind === 'extract'

// 触发节点：入口和定时器。一条链的两个起点 —— 只有执行出边，没有值、没有缓存文件、也没有数据端口。
export const trigger = (node) => node?.kind === 'entry' || node?.kind === 'timer'

// 这个命令节点的命令从哪来：手写的在节点上，引用扩展的在扩展那份清单里（ADR-0014）。
// 认「是不是扩展节点」都走这里，别到处摸 node.extension。
// 它仍然是个命令节点 —— 所以 kind 那一堆分支一个都不用动。
export const extensionOf = (node) => (node?.kind === 'command' && node.extension ? node.extension : '')

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
  fitInputPorts(graph, id, parseTokens(command).length)
}

// 端口上填的常量。空串就当没有——免得存档里留一堆空键；名字对不上任何 token 也不清，
// 用户可能正要把那个 token 写回去。
// 一个常量两处用：`{{名字}}` 拿它当正文，`[[名字]]` 拿它当路径。
export function setNodeConst(graph, id, name, value) {
  const node = findNode(graph, id)
  if (!node) return
  const text = String(value ?? '')
  node.consts ??= {}
  if (text) node.consts[name] = text
  else delete node.consts[name]
}

// 输入端口太矮就被挤没了：端口多了把节点高度兜到够。
// 只往上兜、不缩回去——缩回去会把用户自己拉过的尺寸改掉。长高了返回 true（调用方决定要不要落盘）。
export function fitInputPorts(graph, id, count) {
  const node = findNode(graph, id)
  if (!node || node.kind !== 'command' || !count) return false
  const lastCenter = INPUT_ROW.top + (count - 1) * INPUT_ROW.step
  const room = lastCenter + INPUT_ROW.step / 2 + NODE_FOOT_H
  if (node.h >= room) return false
  node.h = room
  return true
}

// 取法：`json:isFull` 这样一段文本。解析是 pick.mjs 的事，这里只存。
export function setNodePick(graph, id, pick) {
  const node = findNode(graph, id)
  if (!node) return
  node.pick = pick
}

// 时间表：定时器节点上写的一行文本（`每 30 分钟` / `每天 09:30`）。解析是 schedule.mjs 的事，这里只存。
export function setNodeSchedule(graph, id, schedule) {
  const node = findNode(graph, id)
  if (!node) return
  node.schedule = schedule
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
export function connectProblem(graph, from, to, kind, extras = {}) {
  const source = findNode(graph, from)
  const target = findNode(graph, to)
  if (!source || !target) return '节点不在画布上'
  if (from === to) return '不能连到自己'
  const fromPort = extras.fromPort ?? ''
  // 同一对节点之间允许两族的边各一条（UE 里就是两根不同的线）：
  // 执行边定先后、数据边传值，链上两个都要有。
  // 数据边再按出口名区分：两个出口可以各自连到同一个去处。
  if (graph.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind && (edge.fromPort ?? '') === fromPort)) {
    return fromPort
      ? `这两点之间已经有一条从「${fromPort}」出来的数据边了`
      : `这两点之间已经有一条${kind === 'exec' ? '执行边' : '数据边'}了`
  }
  if (kind === 'data') {
    // 触发节点没有值可传，也没有数据端口
    if (trigger(source) || trigger(target)) return '入口和定时器不传值（它们只有执行端口）'
    if (fromPort) {
      if (source.kind !== 'command' || !extensionOf(source)) return '出口只能从扩展节点拉出'
      const names = extras.outputNames
      if (!Array.isArray(names) || !names.includes(fromPort)) return `这个节点没有「${fromPort}」这个出口`
    }
    return null
  }
  if (kind !== 'exec') return `不认识的边：${kind}`

  // 执行边：触发节点（入口 / 定时器）都是起点 —— 只能连会跑的节点，各自只带一根出边。
  // 两者在边上完全同一套，差别只在「什么时候点火」：入口靠人手（以后是子图被调用），定时器到点自己跑。
  if (trigger(source)) {
    const name = source.kind === 'timer' ? '定时器' : '入口'
    if (!runnable(target)) return `${name}只能连会跑的节点（命令节点或提取节点）`
    return execOutAll(graph, from).length ? `${name}只能有一根执行出边` : null
  }
  if (!runnable(source)) return '执行边只能从会跑的节点、入口或定时器出发'
  if (!runnable(target)) return '执行边的去处得是会跑的节点（入口和定时器是起点）'
  // 入边不限根数：走路时光标只有一个，「从哪儿来」永远是确定的，所以多根入边没有歧义；
  // 几条链走到同一个节点上（合流）也是合法的。
  // 空标签是兜底，只能有一根，否则「不匹配时走到哪儿」就说不清了。
  // 出边可以成环（回来指向已经走过的节点），所以这里没有反环检查 —— 兜底靠运行时的步数上限。
  if (execOutAll(graph, from).some((edge) => !(edge.label ?? ''))) return '它的执行输出已经有一根兜底边了'
  return null
}

// 建边：先问 connectProblem，问不过就建不出来。
export function addEdge(graph, from, to, kind = 'data', extras = {}) {
  if (connectProblem(graph, from, to, kind, extras)) return null
  const edge = { id: newId('e'), from, to, kind, label: '' }
  if (extras.fromPort) edge.fromPort = extras.fromPort
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


