// 边层：把边画成 SVG 曲线，处理建边、选中、标签编辑。
import { addEdge, findNode, setEdgeLabel } from '../core/graph.mjs'
import { edgeGeometry, portPoint, previewPath } from '../core/geometry.mjs'
import { toWorld } from '../core/view.mjs'

const SVG_NS = 'http://www.w3.org/2000/svg'

export function mountEdges({ getState, update }) {
  const svg = document.getElementById('edges')
  const labels = document.getElementById('labels')
  const elements = new Map()
  let connecting = null

  function render(state) {
    const alive = new Set()
    for (const edge of state.graph.edges) {
      const from = findNode(state.graph, edge.from)
      const to = findNode(state.graph, edge.to)
      if (!from || !to) continue
      alive.add(edge.id)

      let entry = elements.get(edge.id)
      if (!entry) {
        entry = createEntry(edge.id)
        elements.set(edge.id, entry)
      }

      const { d, mid } = edgeGeometry(from, to)
      entry.hit.setAttribute('d', d)
      entry.line.setAttribute('d', d)
      const selected = state.selection?.kind === 'edge' && state.selection.id === edge.id
      entry.group.classList.toggle('selected', selected)
      entry.line.setAttribute('marker-end', selected ? 'url(#arrow-selected)' : 'url(#arrow)')
      entry.label.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`
      if (entry.labelText !== edge.label) {
        entry.label.textContent = edge.label
        entry.label.classList.toggle('empty', !edge.label)
        entry.labelText = edge.label
      }
    }

    for (const [id, entry] of elements) {
      if (alive.has(id)) continue
      entry.group.remove()
      entry.label.remove()
      elements.delete(id)
    }
  }

  function createEntry(id) {
    const group = document.createElementNS(SVG_NS, 'g')
    group.setAttribute('class', 'edge')
    const hit = document.createElementNS(SVG_NS, 'path')
    hit.setAttribute('class', 'edge-hit')
    const line = document.createElementNS(SVG_NS, 'path')
    line.setAttribute('class', 'edge-line')
    line.setAttribute('marker-end', 'url(#arrow)')
    group.append(hit, line)
    svg.append(group)

    const label = document.createElement('div')
    label.className = 'edge-label empty'
    labels.append(label)

    group.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      select(id)
    })
    group.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      startLabelEdit(id)
    })
    label.addEventListener('pointerdown', (event) => {
      event.stopPropagation()
      select(id)
    })
    label.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      startLabelEdit(id)
    })

    return { group, hit, line, label, labelText: null, editing: false }
  }

  function select(id) {
    update((state) => {
      state.selection = { kind: 'edge', id }
    })
  }

  // 双击边：就地编辑标签，Enter 或失焦保存，Esc 取消，清空即删掉标签。
  function startLabelEdit(id) {
    const entry = elements.get(id)
    if (!entry || entry.editing) return
    const edge = getState().graph.edges.find((item) => item.id === id)
    if (!edge) return

    const original = edge.label ?? ''
    const input = document.createElement('input')
    input.className = 'edge-input'
    input.value = original
    input.placeholder = '标签'
    entry.editing = true
    entry.label.classList.remove('empty')
    entry.label.textContent = ''
    entry.label.append(input)
    input.focus()
    input.select()

    let finished = false
    function finish(commit) {
      if (finished) return
      finished = true
      const value = input.value.trim()
      input.remove()
      entry.editing = false
      entry.labelText = null // 强制重画标签
      if (commit && value !== original) update((state) => setEdgeLabel(state.graph, id, value))
      else render(getState())
    }

    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') finish(true)
      if (event.key === 'Escape') finish(false)
    })
  }

  // 从节点右侧连接点拖到另一个节点：松开即建边。
  function startConnection(fromId, event) {
    if (connecting) return
    const from = findNode(getState().graph, fromId)
    if (!from) return

    const preview = document.createElementNS(SVG_NS, 'path')
    preview.setAttribute('class', 'edge-preview')
    svg.append(preview)
    connecting = { fromId, preview, target: null }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)

    onMove(event)
  }

  function dropTargetAt(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY)
    const node = el?.closest?.('.node')
    return node && node.dataset.id !== connecting.fromId ? node : null
  }

  function onMove(event) {
    const state = getState()
    const from = findNode(state.graph, connecting.fromId)
    if (!from) return stopConnection()
    const cursor = toWorld(state.view, event.clientX, event.clientY)
    connecting.preview.setAttribute('d', previewPath(portPoint(from), cursor))

    const target = dropTargetAt(event)
    if (target !== connecting.target) {
      connecting.target?.classList.remove('drop-target')
      target?.classList.add('drop-target')
      connecting.target = target
    }
  }

  function onUp(event) {
    const target = dropTargetAt(event)
    const fromId = connecting.fromId
    stopConnection()
    if (!target) return
    const toId = target.dataset.id
    let created = null
    update((state) => {
      created = addEdge(state.graph, fromId, toId)
      if (created) state.selection = { kind: 'edge', id: created.id }
    })
  }

  function onKey(event) {
    if (event.key === 'Escape') stopConnection()
  }

  function stopConnection() {
    if (!connecting) return
    connecting.preview.remove()
    connecting.target?.classList.remove('drop-target')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onKey)
    connecting = null
  }

  return { render, startConnection }
}
