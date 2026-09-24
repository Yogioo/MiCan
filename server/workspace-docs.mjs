// 工作文件夹里给 agent 的文档。新文件夹落下；旧的从设置里导入。已有的默认不覆盖。
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'builtin', 'workspace')
export const AGENT_DOCS = ['AGENTS.md', 'ITERATE.md']

const NOTES = {
  'AGENTS.md': '始终加载：纪律和指针',
  'ITERATE.md': '改画布、文本节点、扩展时读',
}

const isFile = async (file) => (await fs.stat(file).catch(() => null))?.isFile() ?? false

export async function listAgentDocs(root) {
  return Promise.all(AGENT_DOCS.map(async (name) => ({
    name,
    description: NOTES[name] ?? '',
    exists: root ? await isFile(path.join(root, name)) : false,
  })))
}

export async function importAgentDoc(root, name, { overwrite = false } = {}) {
  if (!root) throw new Error('先打开一个工作文件夹，文档才有地方放')
  if (!AGENT_DOCS.includes(name)) throw new Error(`不是模板：${name}`)
  const from = path.join(DIR, name)
  const to = path.join(root, name)
  if (!(await isFile(from))) throw new Error(`内置库里没有这一份：${name}`)
  if ((await isFile(to)) && !overwrite) throw new Error(`工作文件夹里已经有了：${name}`)
  await fs.copyFile(from, to)
  return { name, overwritten: overwrite }
}

export async function seedAgentDocs(root) {
  for (const name of AGENT_DOCS) {
    await fs.copyFile(path.join(DIR, name), path.join(root, name), fs.constants.COPYFILE_EXCL).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}
