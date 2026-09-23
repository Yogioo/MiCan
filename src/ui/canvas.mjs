// 画布：平移、缩放、点阵背景，以及空白处左键拖出来的框选。
import { machine } from '../core/settings.mjs'
import { cssTransform, gridMetrics, panBy, toWorld, zoomAt } from '../core/view.mjs'

export function mountCanvas({ getView, setView, subscribe, onBackgroundPress, onBackgroundDblClick, onMarquee, onResetZoom }) {
  const viewport = document.getElementById('viewport')
  const world = document.getElementById('world')
  const grid = document.getElementById('grid')
  const marquee = document.getElementById('marquee')

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
      const factor = Math.exp(-event.deltaY * machine.zoomSensitivity)
      setView(zoomAt(getView(), event.clientX, event.clientY, factor))
    },
    { passive: false },
  )

  // 平移：中键拖动、空格 + 拖动。左键从空白处拖的是框选，不是平移 —— 一只手在空白处
  // 按下时想要的是「圈东西」，平移还有中键和空格两条路。
  let spaceHeld = false
  let panning = null
  let drawing = null // 框选中：起点与指针 id

  function isBackground(target) {
    return target === viewport || target === grid
  }

  viewport.addEventListener('pointerdown', (event) => {
    const background = isBackground(event.target)
    if (!background && !(event.button === 1 || spaceHeld)) return
    // 中键要挡掉浏览器的自动滚屏；左键不能挡，否则输入框不会失焦
    if (event.button === 1) event.preventDefault()
    if (background) onBackgroundPress()
    if (background && event.button === 0 && !spaceHeld) {
      // 左键在空白处按下：先把框备着 —— 动过 dragThreshold 才真的开框，
      // 否则松手只算「点了一下空白」（那件事 onBackgroundPress 刚刚已经做了）。
      drawing = { id: event.pointerId, x: event.clientX, y: event.clientY }
    } else {
      panning = { id: event.pointerId, x: event.clientX, y: event.clientY }
      viewport.classList.add('panning')
    }
    viewport.setPointerCapture(event.pointerId)
  })

  viewport.addEventListener('pointermove', (event) => {
    if (panning && event.pointerId === panning.id) {
      setView(panBy(getView(), event.clientX - panning.x, event.clientY - panning.y))
      panning.x = event.clientX
      panning.y = event.clientY
      return
    }
    if (drawing && event.pointerId === drawing.id) {
      const box = screenBox(drawing, event)
      if (!marquee.hidden || Math.hypot(box.w, box.h) >= machine.dragThreshold) draw(box)
    }
  })

  // 指针站在哪儿，框就是从起点到它的那个矩形（往哪个方向拖都一样）
  function screenBox(from, to) {
    return {
      x: Math.min(from.x, to.clientX),
      y: Math.min(from.y, to.clientY),
      w: Math.abs(to.clientX - from.x),
      h: Math.abs(to.clientY - from.y),
    }
  }

  // 框画在屏幕坐标里：跟指针的位置直接对应，挪一下那个 div 就行。
  // 选中哪几个则要看世界坐标 —— 框不随缩放变，框住的节点却是世界坐标里的。
  function draw(box) {
    const view = getView()
    const topLeft = toWorld(view, box.x, box.y)
    const bottomRight = toWorld(view, box.x + box.w, box.y + box.h)
    marquee.hidden = false
    marquee.style.left = `${box.x}px`
    marquee.style.top = `${box.y}px`
    marquee.style.width = `${box.w}px`
    marquee.style.height = `${box.h}px`
    onMarquee({ x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y })
  }

  function endPointer(event) {
    if (panning && event.pointerId === panning.id) {
      panning = null
      viewport.classList.remove('panning')
    }
    if (drawing && event.pointerId === drawing.id) {
      drawing = null
      marquee.hidden = true
    }
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
  }

  viewport.addEventListener('pointerup', endPointer)
  viewport.addEventListener('pointercancel', endPointer)

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
