// 存档格式：与工作文件夹里的 mican.json 共用的唯一结构。
import { runnable } from './graph.mjs'
import { canvasPatch, machine } from './settings.mjs'
import { clampScale } from './view.mjs'

export const FORMAT_VERSION = 5
const READABLE = new Set([2, 3, 4, FORMAT_VERSION]) // 2 是引入边的两族之前，3 是提取节点之前，4 是画布设置之前

export function serialize(state) {
  return {
    version: FORMAT_VERSION,
    view: { x: state.view.x, y: state.view.y, scale: state.view.scale },
    settings: canvasPatch(), // 跟这份画布走的设置（换工作文件夹打开就跟着变）
    nodes: state.graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      ...(node.kind === 'command'
        ? { command: node.command, ...(node.cwd ? { cwd: node.cwd } : {}), ...(node.entry ? { entry: true } : {}) }
        : node.kind === 'extract'
          ? { pick: node.pick ?? '' }
          : { file: node.file, text: node.text }),
    })),
    edges: state.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label ?? '',
    })),
    results: resultsOf(state.graph),
  }
}

// 运行结果不是图结构：裸输出在缓存文件里，元信息（退出码、耗时、时间、实际跑的命令）在这儿。
// 出参多带一个 results 键，但撤销快照只取 nodes 与 edges，所以运行本身不会进撤销栈。
function resultsOf(graph) {
  const results = {}
  for (const node of graph.nodes) {
    if (!runnable(node) || !node.result) continue
    const { code, failed, timedOut, truncated, at, elapsed, command } = node.result
    // 提取节点不 spawn 进程，没有退出码可报，只记时间
    results[node.id] =
      node.kind === 'extract'
        ? { at, elapsed }
        : { code, failed: Boolean(failed), timedOut: Boolean(timedOut), truncated: Boolean(truncated), at, elapsed, command }
  }
  return results
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
        cwd: typeof node.cwd === 'string' ? node.cwd : '',
        entry: node.entry === true, // 2 版没有这个键，默认不是入口
      }
    }
    if (node.kind === 'extract') {
      return { id: node.id, kind: 'extract', x: node.x, y: node.y, ...size, pick: typeof node.pick === 'string' ? node.pick : '' }
    }
    const file = typeof node.file === 'string' ? node.file : ''
    if (!file || file.startsWith('/') || file.split(/[\\/]/).includes('..')) {
      throw new Error(`节点 ${node.id} 的文件路径不合法：${file}`)
    }
    return { id: node.id, kind: 'text', x: node.x, y: node.y, ...size, file, text: typeof node.text === 'string' ? node.text : '' }
  })

  const ids = new Set(nodes.map((node) => node.id))
  const edges = []
  for (const edge of data.edges) {
    if (!edge || typeof edge.id !== 'string') continue
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue // 悬空的边丢掉
    const kind = edge.kind === 'exec' ? 'exec' : 'data' // 2 版全是文本节点喂命令，都是数据边
    edges.push({ id: edge.id, from: edge.from, to: edge.to, kind, label: typeof edge.label === 'string' ? edge.label : '' })
  }

  // 入口是排他的：有执行入边的节点当不了入口，载入时把不合规的清掉，不留自相矛盾的状态。
  const execTargets = new Set(edges.filter((edge) => edge.kind === 'exec').map((edge) => edge.to))
  for (const node of nodes) if (node.entry && execTargets.has(node.id)) node.entry = false

  // 元信息先挂上，裸输出等缓存文件那一份读回来再填。
  const results = data.results && typeof data.results === 'object' ? data.results : {}
  for (const node of nodes) {
    if (runnable(node) && results[node.id]) node.result = { ...results[node.id], output: '' }
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
    graph: { nodes, edges },
  }
}
