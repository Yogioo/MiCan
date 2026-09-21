// 边的几何：连线走向与中点（纯数学，不碰 DOM）。

const MIN_REACH = 40 // 控制柄最短长度：节点贴在一起时曲线也不塌成直线
const BOW = 60 // 回程边向下兜的幅度：不让 A→B 与 B→A 两条边完全重合

// 两个节点之间的连线：按左右相对位置决定从哪一侧出、哪一侧进。
// 「回程边」多兜一个弯，否则两条反向边会画成同一条线，点也点不中、标签也写错边。
export function edgeGeometry(from, to) {
  const fromCx = from.x + from.w / 2
  const toCx = to.x + to.w / 2
  // 中心 x 相同时用 id 定序，保证 A→B 与 B→A 不会画出同一条线
  const forward = toCx === fromCx ? to.id > from.id : toCx > fromCx
  const start = { x: forward ? from.x + from.w : from.x, y: from.y + from.h / 2 }
  const end = { x: forward ? to.x : to.x + to.w, y: to.y + to.h / 2 }
  const reach = Math.max(MIN_REACH, Math.abs(end.x - start.x) / 2)
  const bow = forward ? 0 : BOW
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

// 节点右侧的连接点：建边都从这里出发。
export function portPoint(node) {
  return { x: node.x + node.w, y: node.y + node.h / 2 }
}

function curve(start, c1, c2, end) {
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`
}
