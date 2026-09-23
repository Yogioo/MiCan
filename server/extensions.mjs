// 扩展：工作文件夹里的一个目录，里面有一份 EXTENSION.md（ADR-0012 / ADR-0013）。
// 扫描只读它的 yaml 头，不 import 任何用户代码 —— 坏脚本拖不垮菜单，扫一遍也不会跑起别人的代码。
// 一条判据：含 EXTENSION.md 的目录就是扩展，是叶子，不再往下扫；不含的只是菜单里的分组，继续往下。
import fs from 'node:fs/promises'
import path from 'node:path'

export const MANIFEST = 'EXTENSION.md'
// 扩展住在工作文件夹的 nodes 底下；节点上存的是相对工作文件夹的路径。
export const EXT_DIR = 'nodes'

// yaml 头：文件开头用 --- 包起来的那几行。认平铺的 `key: value`，外加一层缩进
// （`defaults:` 底下那几个默认值）。不做引号、不做更深的嵌套 —— 四个字段够用了，
// 认不出来的就当这个扩展没认出来（报一句），不猜。
function parseManifest(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (head === undefined) return { error: '开头没有 --- 包起来的 yaml 头' }
  const fields = {}
  const defaults = {}
  let inDefaults = false
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (!key) continue
    // 缩进的行挂在上一行那个顶格字段底下 —— 现在只有 defaults 用得上
    if (/^\s/.test(line)) {
      if (inDefaults) defaults[key] = value
      continue
    }
    inDefaults = key === 'defaults' && !value
    if (!inDefaults) fields[key] = value
  }
  if (!fields.name) return { error: 'yaml 头里没有 name' }
  if (!fields.entry) return { error: 'yaml 头里没有 entry' }
  return {
    name: fields.name,
    description: fields.description ?? '',
    entry: fields.entry,
    args: fields.args ?? '',
    defaults,
  }
}

async function readManifest(dir) {
  const text = await fs.readFile(path.join(dir, MANIFEST), 'utf8').catch(() => null)
  if (text === null) return { error: '读不到 EXTENSION.md' }
  return parseManifest(text)
}

// 菜单树：一项要么是扩展（有 entry），要么是分组（有 children）。目录层级就是菜单层级。
// 认不出来的目录跳过，理由攒在 problems 里 —— 一个坏扩展不该让整棵树消失。
export async function scanExtensions(root) {
  const problems = []
  const walk = async (rel) => {
    const dir = path.join(root, rel)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    if (entries.some((item) => item.isFile() && item.name === MANIFEST)) {
      const meta = await readManifest(dir)
      if (meta.error) {
        problems.push(`${rel}：${meta.error}`)
        return null
      }
      return {
        label: meta.name,
        path: rel,
        description: meta.description,
        entry: meta.entry,
        args: meta.args,
        defaults: meta.defaults,
      }
    }
    const children = []
    const dirs = entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    for (const item of dirs) {
      const child = await walk(`${rel}/${item.name}`)
      if (child) children.push(child)
    }
    return children.length ? { label: path.basename(rel), path: rel, children } : null
  }
  const top = await walk(EXT_DIR)
  return { items: top?.children ?? [], problems }
}

// 节点上那个路径 → 绝对目录。只认工作文件夹 nodes 底下的：存档是可以手改的，别的一律挡掉。
function resolveDir(root, rel) {
  const base = path.resolve(root, EXT_DIR)
  const dir = path.resolve(root, String(rel ?? ''))
  if (dir === base || !dir.startsWith(base + path.sep)) throw new Error(`扩展只能住在 ${EXT_DIR}/ 底下：${rel}`)
  return dir
}

// 按扩展拼出这次要跑的那条命令：入口变成绝对路径，args 原样带上（里面的 {{}} 交给变量替换）。
// 每次运行都现读一遍清单 —— 节点存的是引用（ADR-0014）。运行目录不在这儿定，那是节点的事。
export async function commandOf(root, rel) {
  const dir = resolveDir(root, rel)
  const meta = await readManifest(dir)
  if (meta.error) throw new Error(`扩展 ${rel}：${meta.error}`)
  const entry = path.resolve(dir, meta.entry)
  if (entry === dir || !entry.startsWith(dir + path.sep)) throw new Error(`扩展 ${rel} 的 entry 跑到了目录外面：${meta.entry}`)
  const args = meta.args.trim()
  return { command: `node "${entry}"${args ? ` ${args}` : ''}`, name: meta.name }
}
