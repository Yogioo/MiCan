// 存档格式：与工作文件夹里的 mican.json 共用的唯一结构。
import { NODE_MIN_H, NODE_MIN_W } from './graph.mjs'
import { clampScale } from './view.mjs'

export const FORMAT_VERSION = 2

export function serialize(state) {
  return {
    version: FORMAT_VERSION,
    view: { x: state.view.x, y: state.view.y, scale: state.view.scale },
    nodes: state.graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      ...(node.kind === 'command'
        ? { command: node.command, ...(node.cwd ? { cwd: node.cwd } : {}) }
        : { file: node.file, text: node.text }),
    })),
    edges: state.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label ?? '',
    })),
  }
}

// 校验并还原：不认识的结构直接报错，能救的地方（尺寸过小、悬空的边）就地修掉。
export function deserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('不是有效的 JSON 对象')
  if (data.version !== FORMAT_VERSION) throw new Error(`不支持的版本：${data.version}`)
  if (!Array.isArray(data.nodes)) throw new Error('nodes 不是数组')
  if (!Array.isArray(data.edges)) throw new Error('edges 不是数组')

  const nodes = data.nodes.map((node, index) => {
    if (!node || typeof node.id !== 'string') throw new Error(`第 ${index + 1} 个节点缺少 id`)
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(node[key])) throw new Error(`节点 ${node.id} 的 ${key} 不是数字`)
    }
    const size = { w: Math.max(NODE_MIN_W, node.w), h: Math.max(NODE_MIN_H, node.h) }
    if (node.kind === 'command') {
      return {
        id: node.id,
        kind: 'command',
        x: node.x,
        y: node.y,
        ...size,
        command: typeof node.command === 'string' ? node.command : '',
        cwd: typeof node.cwd === 'string' ? node.cwd : '',
      }
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
    edges.push({ id: edge.id, from: edge.from, to: edge.to, label: typeof edge.label === 'string' ? edge.label : '' })
  }

  const view = data.view ?? {}
  return {
    view: {
      x: Number.isFinite(view.x) ? view.x : 0,
      y: Number.isFinite(view.y) ? view.y : 0,
      scale: Number.isFinite(view.scale) ? clampScale(view.scale) : 1,
    },
    graph: { nodes, edges },
  }
}
