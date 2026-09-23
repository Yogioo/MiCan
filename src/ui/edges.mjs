// 边层：把边画成 SVG 曲线，处理建边、选中、标签编辑。
import { addEdge, connectProblem, findNode, labelProblem, setEdgeLabel } from '../core/graph.mjs'
import { edgeGeometry, inputPortPoint, portPoint, previewPath } from '../core/geometry.mjs'
import { targetPortIndex } from '../core/inputs.mjs'
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

      // 数据边对上了目标节点的哪个命名输入端口，就接到那个端口上（对不上接左侧中点）
      const { d, mid } = edgeGeometry(from, to, edge.kind, targetPortIndex(state.graph, edge, state.extensions))
      entry.hit.setAttribute('d', d)
      entry.line.setAttribute('d', d)
      const selected = state.selection.has(edge.id)
      entry.group.classList.toggle('selected', selected)
      entry.group.classList.toggle('exec', edge.kind === 'exec')
      entry.group.classList.toggle('data', edge.kind !== 'exec')
      entry.line.setAttribute('marker-end', selected ? 'url(#arrow-selected)' : edge.kind === 'exec' ? 'url(#arrow-exec)' : 'url(#arrow)')
      entry.label.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`
      // 两族边都带标签，只是用处不同：数据边上是变量名，执行边上是期望匹配的值。
      const shown = edge.label ?? ''
      // 空标签靠 .empty 类藏起来（CSS 里 display:none）—— 不能用 hidden 属性，
      // 那个属性在双击编辑时会把刚塞进去的输入框一起藏掉。
      entry.label.hidden = false
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
      state.selection = new Set([id])
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
    input.placeholder = edge.kind === 'exec' ? '匹配什么值（留空 = 兜底）' : '变量名'
    entry.editing = true
    entry.label.hidden = false // 空标签的边本来被藏起来，编辑时要让它出来
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
      const changed = commit && value !== original
      const problem = changed ? labelProblem(getState().graph, id, value) : null
      if (problem) onError(problem)
      else if (changed) update((state) => setEdgeLabel(state.graph, id, value))
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
  // options 是命名输入端口专用的：into 表示「从输入端口往别处拉」，那根边是反过来走的，
  // 标签（label）与端口序号（index）也跟着带过来。
  function startConnection(fromId, kind, event, options = null) {
    if (connecting) return
    const from = findNode(getState().graph, fromId)
    if (!from) return

    const preview = document.createElementNS(SVG_NS, 'path')
    preview.setAttribute('class', `edge-preview ${kind}`)
    svg.append(preview)
    connecting = {
      fromId,
      kind,
      preview,
      target: null,
      problem: null,
      into: Boolean(options?.into),
      label: options?.label ?? '',
      index: options?.index ?? 0,
    }

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
    // 从出端口拉出去就从右边的端口起头；从输入端口往别处拉就从那个端口起头（方向反过来）
    const origin = connecting.into ? inputPortPoint(from, connecting.index) : portPoint(from, connecting.kind)
    connecting.preview.setAttribute('d', previewPath(origin, cursor, connecting.into))

    const target = dropTargetAt(event)
    if (target !== connecting.target) {
      connecting.target?.classList.remove('drop-target', 'drop-invalid')
      connecting.problem = null
      if (target) {
        // into 的那根边是「目标 → 这个节点」，能不能连得按这个方向问
        const pair = connecting.into ? [target.dataset.id, connecting.fromId] : [connecting.fromId, target.dataset.id]
        connecting.problem = connectProblem(state.graph, pair[0], pair[1], connecting.kind)
        target.classList.add(connecting.problem ? 'drop-invalid' : 'drop-target')
      }
      connecting.target = target
    }
  }

  function onUp(event) {
    const target = dropTargetAt(event)
    const { fromId, kind, into, label } = connecting
    stopConnection()
    if (!target) return
    const toId = target.dataset.id
    // into：这条边是从别处进这个节点的，方向和标签要反过来算
    const from = into ? toId : fromId
    const to = into ? fromId : toId
    // 拖到哪个命名端口上，就把那个端口名填成边的标签 —— 不必再手打一遍变量名
    const landed = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.node-port-row')?.dataset.name ?? ''
    const wanted = into ? label : landed
    let created = null
    update((state) => {
      created = addEdge(state.graph, from, to, kind)
      if (created && wanted && !labelProblem(state.graph, created.id, wanted)) {
        setEdgeLabel(state.graph, created.id, wanted)
      }
      if (created) state.selection = new Set([created.id])
    })
    if (!created) onError(connectProblem(getState().graph, from, to, kind) ?? '这条边连不上')
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
