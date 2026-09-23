// 边的几何：连线走向与中点（纯数学，不碰 DOM）。
import { machine } from './settings.mjs'

const MIN_REACH = 40 // 控制柄最短长度：节点贴在一起时曲线也不塌成直线

// 两个节点之间的连线：从来路的端口出发，按左右相对位置决定从哪一侧进。
// 「回程边」多兜一个弯，否则两条反向边可能画到一起，点也点不中、标签也写错边。
export function edgeGeometry(from, to, fromKind = 'data') {
  const { start, c1, c2, end } = edgeCurve(from, to, fromKind)
  const mid = {
    x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
    y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
  }
  return { start, end, mid, d: curve(start, c1, c2, end) }
}

// 一条边的三次曲线：起点、两个控制柄、终点。画线用这四个点，框选命中用同一条 ——
// 两边算的是同一根线，不能各算各的。
export function edgeCurve(from, to, fromKind = 'data') {
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
  return { start, c1, c2, end }
}

// 建边过程中从连接点到光标的预览线。
export function previewPath(start, cursor) {
  const reach = Math.max(MIN_REACH, Math.abs(cursor.x - start.x) / 2)
  return curve(start, { x: start.x + reach, y: start.y }, { x: cursor.x - reach, y: cursor.y }, cursor)
}

// 节点右侧的连接点：建边都从这里出发。会跑的节点两个（执行在上、数据在下），
// 文本节点一个；入口和定时器只有执行出边，所以也是居中一个。
// 从哪个点拉出去，就是哪一种边 —— 所以边层不需要再猜。
const PORT_RATIO = { exec: 0.32, data: 0.68 }

export function portPoint(node, kind = 'data') {
  const single = node.kind === 'text' || node.kind === 'entry' || node.kind === 'timer'
  const ratio = single ? 0.5 : PORT_RATIO[kind] ?? 0.5
  return { x: node.x + node.w, y: node.y + node.h * ratio }
}

// 框选：世界坐标里的框与节点矩形只要有重叠就选中（只挨着边、一点都不压上，不算）。
// box 与 node 都是 { x, y, w, h } —— 节点本来就是这个形状，所以直接拿它当矩形用。
export function rectsOverlap(box, node) {
  return box.x < node.x + node.w && node.x < box.x + box.w && box.y < node.y + node.h && node.y < box.y + box.h
}

// 框选一条边：曲线只要有一段落在框里就算选中。端点被罩住是常见情形，先看一眼直接出结果；
// 否则把曲线按取样点切成小段，一段一段比框 —— 比的是线段而不是光点，框住线中间
// 一小截也逃不掉。取样数按曲线长度算（控制多边形长 / 6 世界单位，封在 16～160 段）。
const HIT_STEP = 6
export function curveHitsBox({ start, c1, c2, end }, box) {
  if (pointInBox(start, box) || pointInBox(end, box)) return true
  const hull = dist(start, c1) + dist(c1, c2) + dist(c2, end)
  const steps = Math.min(160, Math.max(16, Math.ceil(hull / HIT_STEP)))
  let prev = start
  for (let i = 1; i <= steps; i += 1) {
    const next = cubicAt(start, c1, c2, end, i / steps)
    if (segmentHitsBox(prev, next, box)) return true
    prev = next
  }
  return false
}

const pointInBox = (p, box) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h

// 线段与框相交（Liang–Barsky：把线段在两个轴上分别裁到框内，裁完还剩下东西就是相交）
function segmentHitsBox(p, q, box) {
  const dx = q.x - p.x
  const dy = q.y - p.y
  let lo = 0
  let hi = 1
  const clip = (origin, delta, min, max) => {
    if (delta === 0) return origin >= min && origin <= max
    let a = (min - origin) / delta
    let b = (max - origin) / delta
    if (a > b) [a, b] = [b, a]
    lo = Math.max(lo, a)
    hi = Math.min(hi, b)
    return lo <= hi
  }
  return clip(p.x, dx, box.x, box.x + box.w) && clip(p.y, dy, box.y, box.y + box.h)
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)

// 三次贝塞尔在 t 处的点（de Casteljau 的展开式）
function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

function curve(start, c1, c2, end) {
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`
}