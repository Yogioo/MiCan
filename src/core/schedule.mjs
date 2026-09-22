// 时间表：定时器节点上写的一行文本，两种形态 —— 「每 30 分钟」和「每天 09:30」。
// 节点上存的是原文，用的时候现解析：存档里的字与界面上的控件就是同一份东西，不另存一份状态。

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAILY = /^(?:每天|每日)?\s*(\d{1,2})\s*[:：]\s*(\d{1,2})$/
const INTERVAL = /^(?:每\s*)?(\d+)\s*(秒钟|秒|分钟|分|小时|时|seconds?|secs?|minutes?|mins?|hours?|hrs?|s|m|h)$/i

// 单位由大到小：一样的时长挑最大的整单位说（「每 2 小时」而不是「每 120 分钟」）。
const UNITS = [
  { unit: '小时', ms: HOUR },
  { unit: '分钟', ms: MINUTE },
  { unit: '秒', ms: SECOND },
]

// 单位词 → 多少毫秒。先小时、再分钟、剩下的都是秒（秒 / s / sec / second）。
function unitMs(word) {
  const text = word.toLowerCase()
  if (text === '小时' || text === '时' || /^h/.test(text)) return HOUR
  if (text === '分钟' || text === '分' || /^m/.test(text)) return MINUTE
  return SECOND
}

// 挑能整除的最大单位。整到秒为底，所以总挑得出来。
const biggestFit = (ms) => UNITS.find((item) => ms % item.ms === 0) ?? UNITS[UNITS.length - 1]

const pad = (value) => String(value).padStart(2, '0')

// 新建的定时器节点带上的时间表：半小时一次，最像「先跑起来看看」的那个默认值。
export const DEFAULT_SCHEDULE = '每 30 分钟'

// 空、格式不对、数值越界都返回 null —— 调用方拿 null 当「没写对」处理（跳过这次调度、节点上标红）。
export function parseSchedule(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const daily = DAILY.exec(raw)
  if (daily) {
    const hour = Number(daily[1])
    const minute = Number(daily[2])
    if (hour > 23 || minute > 59) return null
    return { mode: 'daily', at: `${pad(hour)}:${pad(minute)}` }
  }

  const interval = INTERVAL.exec(raw)
  if (interval) {
    const count = Number(interval[1])
    if (!(count >= 1)) return null
    return { mode: 'interval', every: count * unitMs(interval[2]) }
  }
  return null
}

// 下一次到点的时刻。间隔型对齐到固定相位（每 30 分钟就是整点和半点），
// 这样「前端每次落盘后端重排定时器」不会把倒计时一直往后推、结果永远不响。
export function nextFireAt(schedule, from = Date.now()) {
  if (schedule.mode === 'interval') return (Math.floor(from / schedule.every) + 1) * schedule.every
  const [hour, minute] = schedule.at.split(':').map(Number)
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= from) next.setDate(next.getDate() + 1)
  return next.getTime()
}

// 给人看的一句话，节点上、提示里都用它。认不出的原文返回空串。
export function describeSchedule(schedule) {
  if (!schedule) return ''
  if (schedule.mode === 'daily') return `每天 ${schedule.at}`
  const { unit, ms } = biggestFit(schedule.every)
  return `每 ${schedule.every / ms} ${unit}`
}

// 界面上的控件写回时间表文本。格式只认这一处：跟 parseSchedule 是一对，
// 免得「每 … 分钟」这种写法在界面、后端、文档里各写一遍。
export const intervalText = (count, unit) => `每 ${count} ${unit}`
export const dailyText = (at) => `每天 ${at}`

// 把一份时间表拆回控件要的两个数：间隔型给「数值 + 单位」，每天型给 HH:MM。
export function scheduleFields(schedule) {
  if (!schedule) return null
  if (schedule.mode === 'daily') return { mode: 'daily', at: schedule.at }
  const { unit, ms } = biggestFit(schedule.every)
  return { mode: 'interval', count: schedule.every / ms, unit }
}
