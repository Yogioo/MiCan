// 边层：把边画成 SVG 曲线，处理建边、选中、标签编辑。
import { addEdge, connectProblem, findNode, setEdgeLabel } from '../core/graph.mjs'
import { edgeGeometry, portPoint, previewPath } from '../core/geometry.mjs'
import { toWorld } from '../core/view.mjs'

const SVG_NS = 'http://www.w3.org/2000/svg'

export function mountEdges({ getState, update, onError }) {
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

      const { d, mid } = edgeGeometry(from, to, edge.kind)
      entry.hit.setAttribute('d', d)
      entry.line.setAttribute('d', d)
      const selected = state.selection?.kind === 'edge' && state.selection.id === edge.id
      entry.group.classList.toggle('selected', selected)
      entry.group.classList.toggle('exec', edge.kind === 'exec')
      entry.group.classList.toggle('data', edge.kind !== 'exec')
      entry.line.setAttribute('marker-end', selected ? 'url(#arrow-selected)' : edge.kind === 'exec' ? 'url(#arrow-exec)' : 'url(#arrow)')
      entry.label.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`
      // 标签只是变量名 —— 执行边不携带数据，没有名字可写
      const shown = edge.kind === 'exec' ? '' : edge.label
      entry.label.hidden = edge.kind === 'exec'
      if (entry.labelText !== shown) {
        entry.label.textContent = shown
        entry.label.classList.toggle('empty', !shown)
        entry.labelText = shown
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
    if (!edge || edge.kind === 'exec') return // 执行边没有名字可改

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

  // 从节点的某个连接点拖到另一个节点：松开即建边。kind 由出发的那个端口决定。
  function startConnection(fromId, kind, event) {
    if (connecting) return
    const from = findNode(getState().graph, fromId)
    if (!from) return

    const preview = document.createElementNS(SVG_NS, 'path')
    preview.setAttribute('class', `edge-preview ${kind}`)
    svg.append(preview)
    connecting = { fromId, kind, preview, target: null, problem: null }

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

  // 拖的时候就按 connectProblem 给出能不能连：连得上才高亮，连不上标红，松手时再说原因。
  function onMove(event) {
    const state = getState()
    const from = findNode(state.graph, connecting.fromId)
    if (!from) return stopConnection()
    const cursor = toWorld(state.view, event.clientX, event.clientY)
    connecting.preview.setAttribute('d', previewPath(portPoint(from, connecting.kind), cursor))

    const target = dropTargetAt(event)
    if (target !== connecting.target) {
      connecting.target?.classList.remove('drop-target', 'drop-invalid')
      connecting.problem = null
      if (target) {
        connecting.problem = connectProblem(state.graph, connecting.fromId, target.dataset.id, connecting.kind)
        target.classList.add(connecting.problem ? 'drop-invalid' : 'drop-target')
      }
      connecting.target = target
    }
  }

  function onUp(event) {
    const target = dropTargetAt(event)
    const { fromId, kind } = connecting
    stopConnection()
    if (!target) return
    const toId = target.dataset.id
    let created = null
    update((state) => {
      created = addEdge(state.graph, fromId, toId, kind)
      if (created) state.selection = { kind: 'edge', id: created.id }
    })
    if (!created) onError(connectProblem(getState().graph, fromId, toId, kind) ?? '这条边连不上')
  }

  function onKey(event) {
    if (event.key === 'Escape') stopConnection()
  }

  function stopConnection() {
    if (!connecting) return
    connecting.preview.remove()
    connecting.target?.classList.remove('drop-target', 'drop-invalid')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('keydown', onKey)
    connecting = null
  }

  return { render, startConnection }
}
