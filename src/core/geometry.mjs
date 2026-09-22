// 边的几何：连线走向与中点（纯数学，不碰 DOM）。
import { machine } from './settings.mjs'

const MIN_REACH = 40 // 控制柄最短长度：节点贴在一起时曲线也不塌成直线

// 两个节点之间的连线：从来路的端口出发，按左右相对位置决定从哪一侧进。
// 「回程边」多兜一个弯，否则两条反向边可能画到一起，点也点不中、标签也写错边。
export function edgeGeometry(from, to, fromKind = 'data') {
  const fromCx = from.x + from.w / 2
  const toCx = to.x + to.w / 2
  // 中心 x 相同时用 id 定序，保证 A→B 与 B→A 不会画出同一条线
  const forward = toCx === fromCx ? to.id > from.id : toCx > fromCx
  const start = portPoint(from, fromKind)
  const end = { x: forward ? to.x : to.x + to.w, y: to.y + to.h / 2 }
  const reach = Math.max(MIN_REACH, Math.abs(end.x - start.x) / 2)
  const bow = forward ? 0 : machine.edgeBow
  const c1 = { x: start.x + (forward ? reach : -reach), y: start.y + bow }
  const c2 = { x: end.x - (forward ? reach : -reach), y: end.y + bow }
  const mid = {
    x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
    y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
  }
  return { start, end, mid, d: curve(start, c1, c2, end) }
}

// 建边过程中从连接点到光标的预览线。
export function previewPath(start, cursor) {
  const reach = Math.max(MIN_REACH, Math.abs(cursor.x - start.x) / 2)
  return curve(start, { x: start.x + reach, y: start.y }, { x: cursor.x - reach, y: cursor.y }, cursor)
}

// 节点右侧的连接点：建边都从这里出发。会跑的节点两个（执行在上、数据在下），文本节点一个。
// 从哪个点拉出去，就是哪一种边 —— 所以边层不需要再猜。
const PORT_RATIO = { exec: 0.32, data: 0.68 }

export function portPoint(node, kind = 'data') {
  const ratio = node.kind === 'text' ? 0.5 : PORT_RATIO[kind] ?? 0.5
  return { x: node.x + node.w, y: node.y + node.h * ratio }
}

function curve(start, c1, c2, end) {
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`
}