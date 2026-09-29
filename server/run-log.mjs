// 运行事件日志的落盘一侧（ADR-0031）：追加行、写附件、按天读、过期清理。
// 行与日期的口径在 src/core/run-log.mjs，这里只管碰文件。
import fs from 'node:fs/promises'
import path from 'node:path'
import { LOG_DIR, RUNS_DIR, logFileOf, runDir, runFileName } from '../src/core/paths.mjs'
import { dayOf, parseRows } from '../src/core/run-log.mjs'

// 一次运行的日志分两处：行进 .mican/log/<当天>.jsonl，值（和输入快照）进 .mican/runs/<当天>/。
// 写日志不该把一次运行带崩：调用方都拿 .catch 兜着，这里再把目录建好。

export async function appendRow(root, row) {
  const file = path.join(root, logFileOf(dayOf(row.at)))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
}

// 一步的三份附件。空的不落文件（ADR-0031 的已知风险缓解）：没有输出就没有 .out。
// 返回写进 jsonl 行里的相对路径（相对工作文件夹），取不到的那几项就是 undefined。
export async function writeAttachments(root, at, id, { out, log, input } = {}) {
  const date = dayOf(at)
  const dir = path.join(root, runDir(date))
  await fs.mkdir(dir, { recursive: true })
  const ref = {}
  const put = async (key, ext, text) => {
    if (text === undefined || text === null || text === '') return
    const name = runFileName(at, id, ext)
    await fs.writeFile(path.join(dir, name), text, 'utf8')
    ref[key] = `${runDir(date)}/${name}`
  }
  await put('out', '.out', out)
  await put('log', '.log', log)
  await put('in', '.in.json', input === undefined || input === null ? undefined : JSON.stringify(input, null, 2))
  return ref
}

// 某一天的全部行（坏行丢掉）。
export async function readDay(root, date) {
  return parseRows(await fs.readFile(path.join(root, logFileOf(date)), 'utf8').catch(() => ''))
}

// 盘上有哪几天的日志，新的在前。
export async function listDays(root) {
  const names = await fs.readdir(path.join(root, LOG_DIR)).catch(() => [])
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort()
    .reverse()
}

// 过期清理：logKeepDays 是唯一的规模控制（ADR-0031）。按天的 jsonl 连带同一天的 runs/<日期>/ 整份删。
// 附件被清掉而 jsonl 行还在，是「手动删附件」才可能有的情形：面板照实写「全文已清理」。
export async function cleanOldLogs(root, days) {
  const keep = Math.max(1, Math.trunc(Number(days)) || 1)
  const cutoff = dayOf(Date.now() - (keep - 1) * 86400000)
  const stale = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff
  for (const name of await fs.readdir(path.join(root, LOG_DIR)).catch(() => [])) {
    if (name.endsWith('.jsonl') && stale(name.slice(0, -'.jsonl'.length))) {
      await fs.rm(path.join(root, LOG_DIR, name), { force: true }).catch(() => {})
    }
  }
  for (const name of await fs.readdir(path.join(root, RUNS_DIR)).catch(() => [])) {
    if (stale(name)) await fs.rm(path.join(root, RUNS_DIR, name), { recursive: true, force: true }).catch(() => {})
  }
  return cutoff
}
