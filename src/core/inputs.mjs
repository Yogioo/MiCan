// 一个节点要哪些输入、哪些已经有连线了。
// 输入名就是命令里的 {{名字}} / [[名字]]，所以不需要另一份声明（ADR-0013）：
// 手写的命令节点看它自己的命令，引用扩展的节点看那份清单的 args。
import { dataInto, findNode } from './graph.mjs'
import { parseTokens } from './tokens.mjs'

// 从菜单树里按路径找扩展。找不到就是坏引用 —— 调用方去标红，这里不猜。
export function findExtension(items, path) {
  for (const item of items ?? []) {
    if (item.entry && item.path === path) return item
    const found = findExtension(item.children, path)
    if (found) return found
  }
  return null
}

export function inputsOf(node, extensions) {
  if (node?.kind !== 'command') return []
  if (!node.extension) return parseTokens(node.command)
  const item = findExtension(extensions?.items, node.extension)
  return item ? parseTokens(item.args) : []
}

// 清单里声明的出口名，顺序就是 yaml 里写下的顺序。
export function outputsOf(node, extensions) {
  if (!node?.extension) return []
  const item = findExtension(extensions?.items, node.extension)
  return item?.outputs ? Object.keys(item.outputs) : []
}

// 哪些输入已经有连线了。有连线的端口不看节点上填的常量 —— 边是更明确的那个来源，
// 界面上那个框也会让位（变灰、写「由连线提供」）。
export const wiredNames = (graph, id) =>
  new Set(dataInto(graph, id).map((edge) => edge.label).filter(Boolean))

// 一条数据边该接在目标节点的第几个命名端口上。对不上就是 -1 —— 按老样子接左边中点，
// 不硬塞到某个端口上（标签是空的数据边也有，那本来就没有名字可对）。
export function targetPortIndex(graph, edge, extensions) {
  if (edge.kind !== 'data' || !edge.label) return -1
  return inputsOf(findNode(graph, edge.to), extensions).findIndex((item) => item.name === edge.label)
}

// 数据边从哪个出口出去。没写出口名就是 -1 —— 仍从右侧那个整份值的数据端口走。
export function sourcePortIndex(graph, edge, extensions) {
  if (edge.kind !== 'data' || !edge.fromPort) return -1
  return outputsOf(findNode(graph, edge.from), extensions).findIndex((name) => name === edge.fromPort)
}
