// 视图：画布可见区域（平移 + 缩放）的纯数学，不碰 DOM。
import { machine } from './settings.mjs'

// 点阵在屏幕上允许的间距范围：这是渲染下限，不是给人配的项，跟着点阵间距一起变就行
const GRID_MIN_PX = 12
const GRID_MAX_PX = 48

export function createView() {
  return { x: 0, y: 0, scale: 1 }
}

export function clampScale(scale) {
  return Math.min(machine.zoomMax, Math.max(machine.zoomMin, scale))
}

export function toWorld(view, sx, sy) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }
}

export function toScreen(view, wx, wy) {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y }
}

export function panBy(view, dx, dy) {
  return { x: view.x + dx, y: view.y + dy, scale: view.scale }
}

// 以屏幕上的一点为锚点缩放：该点下方的世界位置保持不动。
export function zoomAt(view, sx, sy, factor) {
  const scale = clampScale(view.scale * factor)
  const world = toWorld(view, sx, sy)
  return { scale, x: sx - world.x * scale, y: sy - world.y * scale }
}

export function cssTransform(view) {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
}

// 点阵在屏幕上的间距与相位：间距按 2 的幂调整，避免缩到极小或极大时糊成一片。
export function gridMetrics(view) {
  let step = machine.gridStep
  let size = step * view.scale
  while (size < GRID_MIN_PX) {
    step *= 2
    size = step * view.scale
  }
  while (size > GRID_MAX_PX) {
    step /= 2
    size = step * view.scale
  }
  const mod = (v) => ((v % size) + size) % size
  return { size, x: mod(view.x), y: mod(view.y) }
}
