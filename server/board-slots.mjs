// 面板属性的值：一份名字对一份 .mican/board/<名字>.md，不进内存当唯一真相。
import fs from 'node:fs/promises'
import path from 'node:path'
import { BOARD_DIR, boardFile } from '../src/core/paths.mjs'

const slotPath = (root, name) => path.join(root, boardFile(name))

export async function readSlot(root, name) {
  return fs.readFile(slotPath(root, name), 'utf8').catch(() => null)
}

export async function writeSlot(root, name, value) {
  const file = slotPath(root, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value ?? '', 'utf8')
}

export async function deleteSlot(root, name) {
  await fs.rm(slotPath(root, name), { force: true })
}

export async function renameSlot(root, from, to) {
  if (!from || !to || from === to) return
  const src = slotPath(root, from)
  const dst = slotPath(root, to)
  const text = await fs.readFile(src, 'utf8').catch(() => null)
  if (text === null) return
  await fs.mkdir(path.dirname(dst), { recursive: true })
  await fs.writeFile(dst, text, 'utf8')
  if (src !== dst) await fs.rm(src, { force: true })
}

export async function readSlots(root) {
  const dir = path.join(root, BOARD_DIR)
  const values = {}
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.md')) continue
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null)
    if (text !== null) values[name.slice(0, -3)] = text
  }
  return values
}

// 声明表叠上盘上的 md：有文件用文件，没有且声明了默认值就当场写下。
export async function liveBoard(root, board = {}) {
  const live = { ...board }
  for (const [name, fallback] of Object.entries(board)) {
    const text = await readSlot(root, name)
    if (text !== null) live[name] = text
    else if (fallback) {
      await writeSlot(root, name, fallback)
      live[name] = fallback
    }
  }
  return live
}
