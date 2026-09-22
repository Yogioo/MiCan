// 变量注入：指到命令节点上的边就是注入边，标签是变量名，上游文本节点的正文是值。
// 命令节点里写 pi --skill {{技能A}}，跑之前被替换掉；替换只发生在运行时，不写回命令。
import { findNode } from './graph.mjs'

// {{名字}}：只认一层，不嵌套。命令最终交给 cmd.exe / sh，{{ }} 不会和 shell 语法打架。
const TOKEN = /\{\{[^{}]*\}\}/g

// 收集入边变量。所有对不上的地方攒起来一次报，别让用户一次修一个。
export function collectVars(graph, id) {
  const vars = new Map()
  const errors = []
  for (const edge of graph.edges) {
    if (edge.to !== id) continue
    if (!edge.label) {
      errors.push('有一条入边没有标签，没名字就当不了变量')
      continue
    }
    const source = findNode(graph, edge.from)
    if (!source || source.kind !== 'text') {
      errors.push(`「${edge.label}」的来路不是文本节点`)
      continue
    }
    if (vars.has(edge.label)) {
      errors.push(`变量名「${edge.label}」有两条入边`)
      continue
    }
    const value = (source.text ?? '').trim()
    // 值直接拼进命令行，没有引号可用（cmd 和 sh 的引号规则不一样），所以只收单行
    if (!value) errors.push(`「${edge.label}」的文本节点是空的`)
    else if (value.includes('\n')) errors.push(`「${edge.label}」的文本有换行，放不进命令行`)
    else vars.set(edge.label, value)
  }
  return { vars, errors }
}

// 只替换声明过的名字：没有对应入边的 {{x}} 原样留下，由调用方报错。
export function applyVars(command, vars) {
  const missing = []
  const resolved = command.replace(TOKEN, (token) => {
    const name = token.slice(2, -2).trim()
    if (!vars.has(name)) {
      missing.push(name)
      return token
    }
    return vars.get(name)
  })
  return { command: resolved, missing }
}
