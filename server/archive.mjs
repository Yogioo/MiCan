// 盘上的存档（ADR-0023）：逻辑、布局、结果、正文四处合起来读；6 版及以前的旧存档读到就地拆开写回。
// 后端的读者（打开工作文件夹、运行器、调度器、进化窗口）都从这儿读，之后只认 7 版。
import fs from 'node:fs/promises'
import path from 'node:path'
import { CANVAS_FILE, LAYOUT_FILE, RESULTS_FILE } from '../src/core/paths.mjs'
import { FORMAT_VERSION, deserialize, split } from '../src/core/serialize.mjs'

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
const objectOr = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

function inside(root, relative) {
  const target = path.resolve(root, relative)
  return target.startsWith(root + path.sep) ? target : null
}

// 正文按每个文本节点的 file 读 md；md 不在就不给（打开是空文本，下次落盘写出来）
async function textsOf(root, canvas) {
  const texts = {}
  for (const node of canvas.nodes ?? []) {
    if (node?.kind !== 'text' || typeof node.file !== 'string') continue
    const file = inside(root, node.file)
    const text = file ? await fs.readFile(file, 'utf8').catch(() => null) : null
    if (text !== null) texts[node.id] = text
  }
  return texts
}

// 旧存档拆成四处写回。md 本来就是存档时写出去的镜像，只补缺的那几份。
async function migrate(root, data) {
  const { canvas, layout, results, texts } = split(data)
  for (const node of canvas.nodes) {
    const file = node.kind === 'text' ? inside(root, node.file) : null
    if (!file || (await fs.stat(file).catch(() => null))) continue
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, texts[node.id] ?? '', 'utf8')
  }
  await fs.mkdir(path.join(root, path.dirname(RESULTS_FILE)), { recursive: true })
  await writeJson(path.join(root, RESULTS_FILE), results)
  await writeJson(path.join(root, LAYOUT_FILE), layout)
  await writeJson(path.join(root, CANVAS_FILE), canvas) // 逻辑最后写：它相当于提交
  return canvas
}

// 拆开的四份：{ canvas, layout, results, texts }。没有存档是 null；存档解析不了就抛。
export async function readArchive(root) {
  const raw = await fs.readFile(path.join(root, CANVAS_FILE), 'utf8').catch(() => null)
  if (raw === null) return null
  let canvas = JSON.parse(raw)
  if (Number.isInteger(canvas?.version) && canvas.version < FORMAT_VERSION) canvas = await migrate(root, canvas)
  const layout = await readJson(path.join(root, LAYOUT_FILE)).catch(() => null)
  return { canvas, layout, results: await readResults(root), texts: await textsOf(root, canvas) }
}

// 还原成一张图：{ view, settings, board, graph }。没有存档是 null。
export async function loadArchive(root) {
  const archive = await readArchive(root)
  return archive ? deserialize(archive) : null
}

const readResults = async (root) => objectOr(await readJson(path.join(root, RESULTS_FILE)).catch(() => ({})))

// 结果只由后端写：运行器、调度器补一格，落盘时按画布上还在的节点收一收。串成一条链，免得互相盖。
let writing = Promise.resolve()
function changeResults(root, change) {
  writing = writing
    .then(async () => {
      const file = path.join(root, RESULTS_FILE)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await writeJson(file, change(await readResults(root)))
    })
    .catch(() => {})
  return writing
}

export const patchResults = (root, patch) => changeResults(root, (data) => ({ ...data, ...patch }))

export const keepResults = (root, ids) =>
  changeResults(root, (data) => Object.fromEntries(Object.entries(data).filter(([id]) => ids.has(id))))
