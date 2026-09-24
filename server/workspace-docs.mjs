// 工作文件夹里给 agent 的文档。模板在 builtin/workspace，跟着软件走。
// 用语正文只维护仓库根的 CONTEXT.md（glossary）；落下 / 导入时拷一份。
// 新文件夹整包落下；旧的从设置里导入。已有的默认不覆盖。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'builtin', 'workspace')
const GLOSSARY = 'CONTEXT.md'

const NOTES = {
  'AGENTS.md': '始终加载：纪律和指针',
  'ITERATE.md': '改画布、文本节点、扩展时读',
  'CONTEXT.md': '画布用语',
  'extensions/README.md': '写扩展的契约',
  '.gitignore': '推荐的忽略规则：只忽略缓存目录',
}

const isFile = async (file) => (await fs.stat(file).catch(() => null))?.isFile() ?? false

function sourceOf(name) {
  if (name === GLOSSARY) return path.join(ROOT, GLOSSARY)
  const from = path.resolve(DIR, name)
  if (from !== DIR && !from.startsWith(DIR + path.sep)) throw new Error(`不是模板：${name}`)
  return from
}

async function walk(rel = '') {
  const entries = await fs.readdir(path.join(DIR, rel), { withFileTypes: true })
  const names = []
  for (const entry of entries) {
    const next = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) names.push(...await walk(next))
    else names.push(next)
  }
  return names
}

async function catalog() {
  const names = await walk()
  if (!names.includes(GLOSSARY)) names.push(GLOSSARY)
  return names
}

export async function listAgentDocs(root) {
  return Promise.all((await catalog()).map(async (name) => ({
    name,
    description: NOTES[name] ?? '',
    exists: root ? await isFile(path.join(root, name)) : false,
  })))
}

export async function importAgentDoc(root, name, { overwrite = false } = {}) {
  if (!root) throw new Error('先打开一个工作文件夹，文档才有地方放')
  const from = sourceOf(name)
  const to = path.join(root, name)
  if (!(await isFile(from))) throw new Error(`内置库里没有这一份：${name}`)
  if ((await isFile(to)) && !overwrite) throw new Error(`工作文件夹里已经有了：${name}`)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return { name, overwritten: overwrite }
}

export async function seedAgentDocs(root) {
  for (const name of await catalog()) {
    const to = path.join(root, name)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(sourceOf(name), to, fs.constants.COPYFILE_EXCL).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}
