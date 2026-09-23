// 选中复制：只出节点与内部边的纯数据，不碰 DOM。
import { newId } from './graph.mjs'

export function snapshotSelection(graph, selected) {
  const ids = new Set()
  for (const node of graph.nodes) if (selected.has(node.id)) ids.add(node.id)
  if (!ids.size) return null
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)).map(pickNode),
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map(pickEdge),
  }
}

export function applyPaste(graph, clip, dx, dy) {
  const map = new Map()
  const nodes = []
  const edges = []
  for (const node of clip.nodes) {
    const id = newId('n')
    map.set(node.id, id)
    nodes.push(placeNode(node, id, dx, dy))
  }
  for (const edge of clip.edges) {
    const next = {
      id: newId('e'),
      from: map.get(edge.from),
      to: map.get(edge.to),
      kind: edge.kind,
      label: edge.label ?? '',
    }
    if (edge.fromPort) next.fromPort = edge.fromPort
    edges.push(next)
  }
  graph.nodes.push(...nodes)
  graph.edges.push(...edges)
  return { nodes, edges }
}

function pickNode(node) {
  const { id, kind, x, y, w, h } = node
  if (kind === 'command') {
    return {
      id,
      kind,
      x,
      y,
      w,
      h,
      command: node.command ?? '',
      cwd: node.cwd ?? '',
      extension: node.extension ?? '',
      consts: { ...(node.consts ?? {}) },
    }
  }
  if (kind === 'extract') return { id, kind, x, y, w, h, pick: node.pick ?? '' }
  if (kind === 'get' || kind === 'set') return { id, kind, x, y, w, h, slot: node.slot ?? '' }
  if (kind === 'entry') return { id, kind, x, y, w, h }
  if (kind === 'timer') return { id, kind, x, y, w, h, schedule: node.schedule ?? '' }
  return { id, kind: 'text', x, y, w, h, text: node.text ?? '' }
}

function pickEdge(edge) {
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    label: edge.label ?? '',
    ...(edge.fromPort ? { fromPort: edge.fromPort } : {}),
  }
}

function placeNode(node, id, dx, dy) {
  const x = node.x + dx
  const y = node.y + dy
  const { kind, w, h } = node
  if (kind === 'command') {
    return {
      id,
      kind,
      x,
      y,
      w,
      h,
      command: node.command ?? '',
      cwd: node.cwd ?? '',
      extension: node.extension ?? '',
      consts: { ...(node.consts ?? {}) },
    }
  }
  if (kind === 'extract') return { id, kind, x, y, w, h, pick: node.pick ?? '' }
  if (kind === 'get' || kind === 'set') return { id, kind, x, y, w, h, slot: node.slot ?? '' }
  if (kind === 'entry') return { id, kind, x, y, w, h }
  if (kind === 'timer') return { id, kind, x, y, w, h, schedule: node.schedule ?? '' }
  return { id, kind: 'text', x, y, w, h, file: `docs/${id}.md`, text: node.text ?? '' }
}
