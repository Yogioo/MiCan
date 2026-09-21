// 节点层：渲染节点（markdown），处理拖动、缩放、选中、编辑。
import { moveNode, resizeNode, setNodeText } from '../core/graph.mjs'
import { renderMarkdown } from './markdown.mjs'

const DRAG_THRESHOLD = 4 // 屏幕像素：移动超过它才算拖动，否则算点击选中

export function mountNodes({ getState, update }) {
  const layer = document.getElementById('nodes')
  const elements = new Map()

  function renderBody(body, node) {
    body.classList.toggle('empty', node.text === '')
    body.innerHTML = renderMarkdown(node.text)
    for (const link of body.querySelectorAll('a[href]')) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
  }

  function render(state) {
    const alive = new Set()
    for (const node of state.graph.nodes) {
      alive.add(node.id)
      let el = elements.get(node.id)
      if (!el) {
        el = createElement()
        el.dataset.id = node.id
        elements.set(node.id, el)
        layer.append(el)
      }
      el.style.transform = `translate(${node.x}px, ${node.y}px)`
      el.style.width = `${node.w}px`
      el.style.height = `${node.h}px`
      el.classList.toggle('selected', state.selection?.id === node.id)
      // 编辑中的节点正文归 textarea 管，这里不碰
      if (el._text !== node.text) {
        renderBody(el.firstElementChild, node)
        el._text = node.text
      }
    }
    for (const [id, el] of elements) {
      if (alive.has(id)) continue
      el.remove()
      elements.delete(id)
    }
  }

  function createElement() {
    const el = document.createElement('div')
    el.className = 'node'
    el.innerHTML = '<div class="node-body"></div><div class="node-handle"></div>'
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      startEdit(el)
    })
    return el
  }

  // 双击：正文变成 textarea，界面与渲染态完全同位同字号，失焦保存、Esc 取消。
  function startEdit(el) {
    if (el.classList.contains('editing')) return
    const id = el.dataset.id
    const node = getState().graph.nodes.find((item) => item.id === id)
    if (!node) return

    const body = el.firstElementChild
    const original = node.text
    const input = document.createElement('textarea')
    input.className = 'node-input'
    input.value = original
    input.spellcheck = false

    el.classList.add('editing')
    body.textContent = ''
    body.append(input)
    input.focus()
    input.setSelectionRange(original.length, original.length)

    let finished = false
    function finish(commit) {
      if (finished) return
      finished = true
      const value = input.value
      input.remove()
      el.classList.remove('editing')
      el._text = null // 强制重画正文
      if (commit && value !== original) update((state) => setNodeText(state.graph, id, value))
      else render(getState())
    }

    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (event) => {
      event.stopPropagation() // 编辑时不把按键交给全局快捷键（Delete、Ctrl+Z 等）
      if (event.key === 'Escape') finish(false)
    })
  }

  // 按下：选中 + 准备拖动或缩放；手柄管缩放，其余位置管移动。
  function onPointerDown(event) {
    if (event.button !== 0) return
    const el = event.currentTarget
    if (el.classList.contains('editing')) return // 编辑态交给 textarea
    event.stopPropagation() // 不触发画布平移

    const id = el.dataset.id
    const node = getState().graph.nodes.find((item) => item.id === id)
    if (!node) return

    const handle = Boolean(event.target.closest('.node-handle'))
    const origin = { px: event.clientX, py: event.clientY, x: node.x, y: node.y, w: node.w, h: node.h }
    let moved = false

    update((state) => {
      state.selection = { kind: 'node', id }
    })

    el.setPointerCapture(event.pointerId)

    function onMove(moveEvent) {
      const dx = moveEvent.clientX - origin.px
      const dy = moveEvent.clientY - origin.py
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      moved = true
      const { scale } = getState().view
      if (handle) {
        update((state) => resizeNode(state.graph, id, origin.w + dx / scale, origin.h + dy / scale))
      } else {
        update((state) => moveNode(state.graph, id, origin.x + dx / scale, origin.y + dy / scale))
      }
    }

    function onEnd() {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onEnd)
      el.removeEventListener('pointercancel', onEnd)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onEnd)
    el.addEventListener('pointercancel', onEnd)
  }

  return { render }
}
