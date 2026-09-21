// 画布：平移、缩放、点阵背景。
import { cssTransform, gridMetrics, panBy, toWorld, zoomAt } from '../core/view.mjs'

const ZOOM_SENSITIVITY = 0.0015

export function mountCanvas({ getView, setView, subscribe, onBackgroundPress, onBackgroundDblClick, onResetZoom }) {
  const viewport = document.getElementById('viewport')
  const world = document.getElementById('world')
  const grid = document.getElementById('grid')

  function render(state) {
    const view = state.view
    world.style.transform = cssTransform(view)
    const metrics = gridMetrics(view)
    grid.style.backgroundSize = `${metrics.size}px ${metrics.size}px`
    grid.style.backgroundPosition = `${metrics.x}px ${metrics.y}px`
  }

  // 滚轮缩放：以鼠标位置为锚点（触控板捏合也会走这里）。
  viewport.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * ZOOM_SENSITIVITY)
      setView(zoomAt(getView(), event.clientX, event.clientY, factor))
    },
    { passive: false },
  )

  // 平移：空白处拖动、中键拖动、空格 + 拖动。
  let spaceHeld = false
  let panning = null

  function isBackground(target) {
    return target === viewport || target === grid
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (!isBackground(event.target) && !(event.button === 1 || spaceHeld)) return
    // 中键要挡掉浏览器的自动滚屏；左键不能挡，否则输入框不会失焦
    if (event.button === 1) event.preventDefault()
    if (isBackground(event.target)) onBackgroundPress()
    panning = { id: event.pointerId, x: event.clientX, y: event.clientY }
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add('panning')
  })

  viewport.addEventListener('pointermove', (event) => {
    if (!panning || event.pointerId !== panning.id) return
    setView(panBy(getView(), event.clientX - panning.x, event.clientY - panning.y))
    panning.x = event.clientX
    panning.y = event.clientY
  })

  function endPan(event) {
    if (!panning || event.pointerId !== panning.id) return
    panning = null
    viewport.releasePointerCapture(event.pointerId)
    viewport.classList.remove('panning')
  }

  viewport.addEventListener('pointerup', endPan)
  viewport.addEventListener('pointercancel', endPan)

  viewport.addEventListener('dblclick', (event) => {
    if (!isBackground(event.target)) return
    onBackgroundDblClick(toWorld(getView(), event.clientX, event.clientY))
  })

  window.addEventListener('keydown', (event) => {
    if (event.key === ' ' && !spaceHeld) {
      spaceHeld = true
      document.body.classList.add('space-ready')
      event.preventDefault()
    }
    if (event.ctrlKey && event.key === '0') {
      event.preventDefault()
      onResetZoom()
    }
  })

  window.addEventListener('keyup', (event) => {
    if (event.key === ' ') {
      spaceHeld = false
      document.body.classList.remove('space-ready')
    }
  })

  subscribe(render)
}
