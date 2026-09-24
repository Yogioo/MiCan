// 存档格式：与工作文件夹里的 mican.json 共用的唯一结构。
import { CMD_BAR_H } from './geometry.mjs'
import { newId, runnable } from './graph.mjs'
import { DEFAULT_SCHEDULE } from './schedule.mjs'
import { boardIn, boardPatch, canvasPatch, machine } from './settings.mjs'
import { clampScale } from './view.mjs'

export const FORMAT_VERSION = 6
// 2 是引入边的两族之前，3 是提取节点之前，4 是画布设置之前，5 是入口节点之前
const READABLE = new Set([2, 3, 4, 5, FORMAT_VERSION])

export function serialize(state) {
  const board = boardPatch()
  return {
    version: FORMAT_VERSION,
    view: { x: state.view.x, y: state.view.y, scale: state.view.scale },
    settings: canvasPatch(), // 跟这份画布走的设置（换工作文件夹打开就跟着变）
    ...(board ? { board } : {}), // 面板：空表不写进存档
    nodes: state.graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      ...(node.kind === 'command'
        ? {
            command: node.command,
            ...(node.cwd ? { cwd: node.cwd } : {}),
            ...(node.extension ? { extension: node.extension } : {}),
            ...constsPatch(node),
          }
        : node.kind === 'extract'
          ? { pick: node.pick ?? '' }
          : node.kind === 'get' || node.kind === 'set'
            ? { slot: node.slot ?? '' }
          : node.kind === 'timer'
            ? { schedule: node.schedule ?? '' }
            : node.kind === 'entry'
              ? {}
              : { file: node.file, text: node.text }),
    })),
    edges: state.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label ?? '',
      ...(edge.fromPort ? { fromPort: edge.fromPort } : {}),
    })),
    results: resultsOf(state.graph),
  }
}

// 运行结果不是图结构：裸输出在缓存文件里，元信息（退出码、耗时、时间、实际跑的命令）在这儿。
// 出参多带一个 results 键，但撤销快照只取 nodes 与 edges，所以运行本身不会进撤销栈。
// 定时器不是「跑出来的结果」，是「上次什么时候响的」，也放这儿 —— 前端整包落盘时才带得回去。
function resultsOf(graph) {
  const results = {}
  for (const node of graph.nodes) {
    if (!node.result) continue
    if (runnable(node)) results[node.id] = resultMeta(node)
    else if (node.kind === 'timer') results[node.id] = triggerMeta(node)
  }
  return results
}

// 定时器的一笔触发记录：什么时候响的、这一下是跑了还是跳过了。
export function triggerMeta(node) {
  const { at, skipped, note } = node.result
  return { at, skipped: Boolean(skipped), ...(note ? { note } : {}) }
}

// 一个会跑的节点存进存档的那点元信息。裸输出不进存档（它在缓存文件里）。
// 前端的整包落盘和后端跑完的补写（server/runner.mjs）都得是同一个口径，所以放这儿共用。
export function resultMeta(node) {
  const { code, failed, timedOut, truncated, at, elapsed, command } = node.result
  // 提取节点不 spawn 进程，没有退出码可报，只记时间
  return node.kind === 'command'
    ? { code, failed: Boolean(failed), timedOut: Boolean(timedOut), truncated: Boolean(truncated), at, elapsed, command }
    : { at, elapsed }
}

// 端口上填的常量：非空的字符串才写进存档，一个都没有就不写这个键。
const constsPatch = (node) => {
  const out = constsIn(node.consts)
  return Object.keys(out).length ? { consts: out } : {}
}

// 外来的存档（手改、旧版本、写坏了）：常量只认非空字符串，其余一律丢掉。
function constsIn(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' && value) out[key] = value
  return out
}

// 校验并还原：不认识的结构直接报错，能救的地方（尺寸过小、悬空的边）就地修掉。
export function deserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('不是有效的 JSON 对象')
  if (!READABLE.has(data.version)) throw new Error(`不支持的版本：${data.version}`)
  if (!Array.isArray(data.nodes)) throw new Error('nodes 不是数组')
  if (!Array.isArray(data.edges)) throw new Error('edges 不是数组')

  const nodes = data.nodes.map((node, index) => {
    if (!node || typeof node.id !== 'string') throw new Error(`第 ${index + 1} 个节点缺少 id`)
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(node[key])) throw new Error(`节点 ${node.id} 的 ${key} 不是数字`)
    }
    const size = { w: Math.max(machine.nodeMinW, node.w), h: Math.max(machine.nodeMinH, node.h) }
    if (node.kind === 'command') {
      return {
        id: node.id,
        kind: 'command',
        x: node.x,
        y: node.y,
        ...size,
        command: typeof node.command === 'string' ? node.command : '',
        // 端口上填的常量（见 graph.mjs 的 setNodeConst）
        consts: constsIn(node.consts),
        cwd: typeof node.cwd === 'string' ? node.cwd : '',
        // 引用扩展的节点：存的是扩展目录（相对工作文件夹），命令在跑的时候现拼（ADR-0014）
        extension: typeof node.extension === 'string' ? node.extension : '',
      }
    }
    if (node.kind === 'extract') {
      return { id: node.id, kind: 'extract', x: node.x, y: node.y, ...size, pick: typeof node.pick === 'string' ? node.pick : '' }
    }
    if (node.kind === 'get') {
      return { id: node.id, kind: 'get', x: node.x, y: node.y, w: size.w, h: CMD_BAR_H, slot: typeof node.slot === 'string' ? node.slot : '' }
    }
    if (node.kind === 'set') {
      return { id: node.id, kind: 'set', x: node.x, y: node.y, ...size, slot: typeof node.slot === 'string' ? node.slot : '' }
    }
    if (node.kind === 'entry') return { id: node.id, kind: 'entry', x: node.x, y: node.y, ...size }
    if (node.kind === 'timer') {
      return {
        id: node.id,
        kind: 'timer',
        x: node.x,
        y: node.y,
        ...size,
        schedule: typeof node.schedule === 'string' && node.schedule.trim() ? node.schedule : DEFAULT_SCHEDULE,
      }
    }
    const file = typeof node.file === 'string' ? node.file : ''
    if (!file || file.startsWith('/') || file.split(/[\\/]/).includes('..')) {
      throw new Error(`节点 ${node.id} 的文件路径不合法：${file}`)
    }
    return { id: node.id, kind: 'text', x: node.x, y: node.y, ...size, file, text: typeof node.text === 'string' ? node.text : '' }
  })

  // 5 版及以前，「入口」是命令节点上的一个布尔值；6 版起它是一枚独立的节点。
  // 载入时把旧标记就地换成一根入口节点 + 一根执行边，画布照样跑，不用用户重连。
  const migrated = []
  if (data.version < 6) {
    for (const [index, node] of nodes.entries()) {
      if (node.kind !== 'command' || data.nodes[index]?.entry !== true) continue
      const entry = { id: newId('n'), kind: 'entry', x: node.x, y: node.y - 90, w: machine.nodeDefaultW, h: machine.nodeDefaultH }
      nodes.push(entry)
      migrated.push({ id: newId('e'), from: entry.id, to: node.id, kind: 'exec', label: '' })
    }
  }

  const ids = new Set(nodes.map((node) => node.id))
  const kindOf = new Map(nodes.map((node) => [node.id, node.kind]))
  const isRunnable = (id) => {
    const kind = kindOf.get(id)
    return kind === 'command' || kind === 'extract' || kind === 'set'
  }
  // 触发节点是起点：进来一根执行边、或跟它传数据，都是没意义的状态，载入时直接丢掉。
  // 获取像文本：只出数据，不接数据，也不走执行边。
  const edgeOk = (kind, from, to) => {
    const a = kindOf.get(from)
    const b = kindOf.get(to)
    if (kind === 'data') {
      if (a === 'entry' || a === 'timer' || b === 'entry' || b === 'timer') return false
      return b !== 'get'
    }
    if (a === 'entry' || a === 'timer') return isRunnable(to)
    return isRunnable(from) && isRunnable(to)
  }

  const source = [...data.edges, ...migrated]
  const edges = []
  for (const edge of source) {
    if (!edge || typeof edge.id !== 'string') continue
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue // 悬空的边丢掉
    const kind = edge.kind === 'exec' ? 'exec' : 'data' // 2 版全是文本节点喂命令，都是数据边
    // 最早的 6 版把定时器接在入口前面（「定时器 → 入口 → 命令」）。入口与定时器本来就是并列的
    // 两种触发，定时器不该再挂一层：把它的出边挪到那个入口指着的第一个会跑的节点上。
    // 入口节点留着（它还是「人手跑这条链」的入口），所以这条链会多一根并排进来的边。
    let to = edge.to
    if (kind === 'exec' && kindOf.get(edge.from) === 'timer' && kindOf.get(to) === 'entry') {
      const head = source.find((item) => item?.kind === 'exec' && item.from === to)?.to
      if (isRunnable(head)) to = head
    }
    if (!edgeOk(kind, edge.from, to)) continue
    edges.push({
      id: edge.id,
      from: edge.from,
      to,
      kind,
      label: typeof edge.label === 'string' ? edge.label : '',
      ...(typeof edge.fromPort === 'string' && edge.fromPort ? { fromPort: edge.fromPort } : {}),
    })
  }

  // 元信息先挂上，裸输出等缓存文件那一份读回来再填（触发记录没有裸输出）。
  const results = data.results && typeof data.results === 'object' ? data.results : {}
  for (const node of nodes) {
    if (!results[node.id]) continue
    if (runnable(node)) node.result = { ...results[node.id], output: '' }
    else if (node.kind === 'timer') node.result = { ...results[node.id] }
  }

  const view = data.view ?? {}
  return {
    view: {
      x: Number.isFinite(view.x) ? view.x : 0,
      y: Number.isFinite(view.y) ? view.y : 0,
      scale: Number.isFinite(view.scale) ? clampScale(view.scale) : 1,
    },
    // 画布设置原样带出来，由调用方决定什么时候收进来（撤销快照里没有这一段，别顺手改了全局）
    settings: data.settings ?? null,
    // 面板同理：不进撤销快照；没有这个键就是空表（旧存档）
    board: boardIn(data.board),
    graph: { nodes, edges },
  }
}
