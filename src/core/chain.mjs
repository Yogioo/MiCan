// 链：执行边两头都是单连接，所以一个组件就是一条直线 —— 从起点顺着走到底。
import { execOut } from './graph.mjs'

// 往前走：从 id 出发（含自己），到这条链的末尾。
export function walkDown(graph, id) {
  const ids = []
  const seen = new Set()
  let cursor = id
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    ids.push(cursor)
    cursor = execOut(graph, cursor)?.to ?? null
  }
  return ids
}
