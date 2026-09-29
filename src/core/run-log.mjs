// 运行事件日志（ADR-0031）：一行一件事，按天一份 jsonl。这里只放「怎么读这份东西」的口径，
// 前后端共用（面板、诊断扩展、自动进化都按它认行）。落盘那几件事在 server/run-log.mjs。
//
// 五种行，用 t 分：
//   run  开跑那一刻就写（实时盯靠它），一次运行一个单位
//   step 一步跑完写一行（只有跑完才写），值在附件里，行上只有引用和摘要
//   skip 点了火但没跑（链身被占 / 正在进化），自己一行
//   say  人插的一句话（ADR-0032）。它是一句人话，不是这一步的值 —— 全文就在行上，不进附件
//   end  收尾：结果、步数、耗时的那句人话。没有 end 行的 run 就是还在跑。

// 日期按本地时区算：日志是给人看的「今天」，不是 UTC 的今天。
export const dayOf = (at) => {
  const date = new Date(at ?? Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// 列表里那几个截短字段（routeValue / digest）只是索引，不是值的住所 —— 全文永远在附件里。
export const clipText = (text, size = 40) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > size ? `${value.slice(0, size)}…` : value
}

export const firstLine = (text) => String(text ?? '').split(/\r?\n/, 1)[0].trim()

// 一行一段 JSON；坏行（写到一半断了）丢掉，不连累前后。
export const parseRows = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        const row = JSON.parse(line)
        return row && typeof row === 'object' ? [row] : []
      } catch {
        return []
      }
    })

// 结论：没有 end 就是还在跑。
export const OUTCOMES = { ok: '跑完', failed: '失败', stuck: '卡住', limit: '超步数', stopped: '停了', error: '没跑起来' }
export const outcomeText = (outcome) => (outcome ? OUTCOMES[outcome] ?? outcome : '进行中')
// 异常（永远不折叠）跟「跑完」相对
export const isBad = (outcome) => Boolean(outcome) && outcome !== 'ok'
