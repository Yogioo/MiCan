// 变量注入：指到命令节点上的数据边，标签是变量名，来路的节点是变量值的出处；
// 节点自己也可以填常量（端口左边的那些框），填了就不必接边。
// 命令节点里写 pi --skill {{技能A}}，跑之前被替换掉；替换只发生在运行时，不写回命令。
import { dataInto, findNode } from './graph.mjs'
import { cacheFile } from './paths.mjs'
import { TOKEN } from './tokens.mjs'

// 节点上的路径是相对工作文件夹的 posix 路径，拼成这台机器上的绝对路径。
// 运行目录可能不在工作文件夹里，所以路径必须绝对才有得跑。
function fileOf(workspace, file) {
  if (!workspace) return file
  const sep = workspace.includes('\\') ? '\\' : '/'
  const root = workspace.replace(/[\\/]+$/, '')
  return [root, ...file.split(/[\\/]+/).filter(Boolean)].join(sep)
}

// 来路的两副面孔，取出来的都是同一样东西 { text, file }：
// 文本节点的值是它那份 md，命令节点的值是它的缓存文件。所以两种节点共用一套 token 规则。
// 命令节点没跑过就等于没有值，返回 null 让调用方去报错。
function valueOf(workspace, source) {
  if (source.kind === 'text') {
    return { text: (source.text ?? '').trim(), file: fileOf(workspace, source.file ?? '') }
  }
  if (!source.result) return null
  return { text: (source.result.output ?? '').trim(), file: fileOf(workspace, cacheFile(source.id)) }
}

// 收集入边变量。所有对不上的地方攒起来一次报，别让用户一次修一个。
// 值的合法性（空、换行）不在这里管：只有真被写进命令的那一个才算数。
export function collectVars(graph, id, workspace) {
  const vars = new Map()
  const errors = []
  // 节点上填的常量先放进来：同一个名字既有常量又接了边时，边说了算（界面上那个框也会让位）。
  // 常量一个字符串两处用 —— `{{名字}}` 拿它当正文，`[[名字]]` 拿它当路径，各取各的。
  for (const [name, value] of Object.entries(findNode(graph, id)?.consts ?? {})) {
    const text = String(value ?? '').trim()
    if (text) vars.set(name, { text, file: text })
  }
  const fromEdges = new Set()
  for (const edge of dataInto(graph, id)) {
    if (!edge.label) {
      errors.push('有一条入边没有标签，没名字就当不了变量')
      continue
    }
    const source = findNode(graph, edge.from)
    if (!source) continue
    if (fromEdges.has(edge.label)) {
      errors.push(`变量名「${edge.label}」有两条入边`)
      continue
    }
    fromEdges.add(edge.label)
    const value = valueOf(workspace, source)
    if (!value) {
      errors.push(`「${edge.label}」的来路是命令节点，它还没跑过`)
      continue
    }
    vars.set(edge.label, value)
  }
  return { vars, errors }
}

// 只替换声明过的名字：没有对应入边的 token 原样留下，攒进 problems 由调用方报错。
export function applyVars(command, vars) {
  const problems = []
  const pick = (raw, name, field) => {
    const entry = vars.get(name)
    if (!entry) {
      problems.push(`${raw} 既没有入边也没有填值`)
      return raw
    }
    const value = entry[field]
    // 值直接拼进命令行，没有引号可用（cmd 和 sh 的引号规则不一样），所以只收单行
    if (!value) {
      problems.push(`${raw} 的${field === 'file' ? '缓存文件还没落盘' : '文本节点是空的'}`)
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
