// 撤销栈：存 JSON 快照，只认「结构变了」这件事（纯数据，不碰 DOM）。

export function createHistory(limit = 50) {
  return { past: [], future: [], limit }
}

// 记一次「改动前」的快照；记过之后重做栈作废。
export function push(history, snapshot) {
  history.past.push(snapshot)
  if (history.past.length > history.limit) history.past.shift()
  history.future.length = 0
}

export function undo(history, current) {
  if (history.past.length === 0) return null
  history.future.push(current)
  return history.past.pop()
}

export function redo(history, current) {
  if (history.future.length === 0) return null
  history.past.push(current)
  return history.future.pop()
}
