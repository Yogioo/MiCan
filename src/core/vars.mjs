// 变量注入：指到命令节点上的边就是注入边，标签是变量名，上游文本节点的正文是值。
// 命令节点里写 pi --skill {{技能A}}，跑之前被替换掉；替换只发生在运行时，不写回命令。
import { findNode } from './graph.mjs'

// 两种取法，一个名字：{{名字}} 取文本节点的正文，[[名字]] 取它那份 md 文件的本机绝对路径。
// 都只认一层、不嵌套。命令最终交给 cmd.exe / sh，两种括号都不是 shell 语法，不会打架。
const TOKEN = /\{\{([^{}]*)\}\}|\[\[([^[\]]*)\]\]/g

// 节点上的 file 是相对工作文件夹的 posix 路径，拼成这台机器上的绝对路径。
// 运行目录可能不在工作文件夹里，所以路径必须绝对才有得跑。
function fileOf(workspace, file) {
  if (!workspace) return file
  const sep = workspace.includes('\\') ? '\\' : '/'
  const root = workspace.replace(/[\\/]+$/, '')
  return [root, ...file.split(/[\\/]+/).filter(Boolean)].join(sep)
}

// 收集入边变量。所有对不上的地方攒起来一次报，别让用户一次修一个。
// 值的合法性（空、换行）不在这里管：只有真被写进命令的那一个才算数。
export function collectVars(graph, id, workspace) {
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
    vars.set(edge.label, {
      text: (source.text ?? '').trim(),
      file: fileOf(workspace, source.file ?? ''),
    })
  }
  return { vars, errors }
}

// 只替换声明过的名字：没有对应入边的 token 原样留下，攒进 problems 由调用方报错。
export function applyVars(command, vars) {
  const problems = []
  const pick = (raw, name, field) => {
    const entry = vars.get(name)
    if (!entry) {
      problems.push(`${raw} 没有对应的入边`)
      return raw
    }
    const value = entry[field]
    // 值直接拼进命令行，没有引号可用（cmd 和 sh 的引号规则不一样），所以只收单行
    if (!value) {
      problems.push(`${raw} 的文本节点是空的`)
      return raw
    }
    if (value.includes('\n')) {
      problems.push(`${raw} 的值有换行，放不进命令行`)
      return raw
    }
    return value
  }
  const resolved = command.replace(TOKEN, (raw, text, file) => {
    if (file === undefined) return pick(raw, text.trim(), 'text')
    const name = file.trim()
    // bash 的 [[ 后面必须跟空白，所以括号里带空白的当 shell 语法放行（[[ -f "$f" ]] 不受影响）
    if (!name || /\s/.test(name)) return raw
    return pick(raw, name, 'file')
  })
  return { command: resolved, problems }
}
