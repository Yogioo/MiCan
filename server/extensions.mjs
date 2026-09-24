// 扩展：工作文件夹里的一个目录，里面有一份 EXTENSION.md（ADR-0012 / ADR-0013）。
// 扫描只读它的 yaml 头，不 import 任何用户代码 —— 坏脚本拖不垮菜单，扫一遍也不会跑起别人的代码。
// 一条判据：含 EXTENSION.md 的目录就是扩展，是叶子，不再往下扫；不含的只是菜单里的分组，继续往下。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRoutes } from '../src/core/inputs.mjs'

export const MANIFEST = 'EXTENSION.md'
// 扩展住在工作文件夹的 extensions 底下；节点上存的是相对工作文件夹的路径。
// 不叫 nodes：存档里那个 nodes 是画布上的节点数组，两回事，别让同一个词身兼二职。
export const EXT_DIR = 'extensions'

// 内置库：随软件带走的一份扩展样本（仓库根下的 builtin/）。它**不是运行时的第二层** ——
// 菜单只扫工作文件夹（ADR-0012），这里的东西只能靠**拷**进去。
// 库的布局跟工作文件夹一样（`<库根>/extensions/<名字>`），所以扫描与越界闸门都原样复用。
// 路径从本文件算（vite 把 config 连我们打包时会逐文件注入 import.meta.url，算出来仍是真的）。
export const LIBRARY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'builtin')

// yaml 头：文件开头用 --- 包起来的那几行。认平铺的 `key: value`，外加一层缩进
// （`defaults:` / `outputs:` 底下那几行）。不做引号、不做更深的嵌套。
// 认不出来的就当这个扩展没认出来（报一句），不猜。
const NESTED = new Set(['defaults', 'outputs'])

function parseManifest(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/.exec(text)
  const head = match?.[1]
  if (head === undefined) return { error: '开头没有 --- 包起来的 yaml 头' }
  const fields = {}
  const nested = { defaults: {}, outputs: {} }
  let nest = ''
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (!key) continue
    // 缩进的行挂在上一行那个顶格字段底下
    if (/^\s/.test(line)) {
      if (nest) nested[nest][key] = value
      continue
    }
    nest = NESTED.has(key) && !value ? key : ''
    if (!nest) fields[key] = value
  }
  if (!fields.name) return { error: 'yaml 头里没有 name' }
  if (!fields.entry) return { error: 'yaml 头里没有 entry' }
  return {
    name: fields.name,
    description: fields.description ?? '',
    entry: fields.entry,
    args: fields.args ?? '',
    defaults: nested.defaults,
    outputs: nested.outputs,
    route: fields.route ?? '',
    routes: parseRoutes(fields.routes),
    docs: (match[2] ?? '').trim(),
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
        outputs: meta.outputs,
        route: meta.route,
        routes: meta.routes,
        docs: meta.docs,
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

// 节点上那个路径 → 绝对目录。只认工作文件夹 extensions 底下的：存档是可以手改的，别的一律挡掉。
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
  // defaults / outputs / route 一并交回去：输入兜底、出口与选路都现读清单（ADR-0015 / ADR-0017）
  return {
    command: `node "${entry}"${args ? ` ${args}` : ''}`,
    entry,
    name: meta.name,
    defaults: meta.defaults,
    outputs: meta.outputs,
    route: meta.route,
  }
}

const isDirectory = async (dir) => (await fs.stat(dir).catch(() => null))?.isDirectory() ?? false

// 库里有什么。exists 说的是「工作文件夹里已经有同一个目录了」—— 按目录判，不按菜单里的名字判，
// 因为冲突真正发生在盘上的路径。界面据此问用户是覆盖还是跳过。
export async function listLibrary(workspace) {
  const { items, problems } = await scanExtensions(LIBRARY_ROOT)
  const flat = []
  const walk = (list) => {
    for (const item of list ?? []) {
      if (item.entry) flat.push(item)
      else walk(item.children)
    }
  }
  walk(items)
  const out = []
  for (const item of flat) {
    out.push({
      label: item.label,
      description: item.description,
      path: item.path, // 跟工作文件夹里同一个相对路径，如 extensions/pi
      exists: workspace ? await isDirectory(path.resolve(workspace, item.path)) : false,
    })
  }
  return { items: out, problems }
}

// 从内置库拷一份进工作文件夹。目标已经有了就抛错 —— 覆盖与否由调用方问过用户再传 overwrite。
// 整个目录搬：正文、实现、连它自带的依赖一起走（MiCan 不解析它们，只是搬）。
export async function importExtension(workspace, rel, { overwrite = false } = {}) {
  if (!workspace) throw new Error('先打开一个工作文件夹，扩展才有地方放')
  const from = resolveDir(LIBRARY_ROOT, rel)
  const to = resolveDir(workspace, rel)
  if (!(await isDirectory(from))) throw new Error(`内置库里没有这一份：${rel}`)
  if (await isDirectory(to)) {
    if (!overwrite) throw new Error(`工作文件夹里已经有了：${rel}`)
    await fs.rm(to, { recursive: true, force: true })
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { recursive: true })
  return { path: rel, overwritten: overwrite }
}
