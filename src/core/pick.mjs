// 取法：从一段文本里取出一个字符串。提取节点的「值」就是它 —— 选路和变量都拿它用。
// 软件只认格式与路径，不认业务：以后加 yaml、xpath 只是在 pickValue 里多一个分支。

// 取法写成一段能编辑的文本：`json:isFull`、`json:a.b`；不写格式（`isFull`）就是 json。
export function parsePick(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { error: '还没填取法' }
  const at = raw.indexOf(':')
  if (at < 0) return { format: 'json', path: raw }
  const format = raw.slice(0, at).trim().toLowerCase()
  const path = raw.slice(at + 1).trim()
  if (!KNOWN.includes(format)) return { error: `不认识的格式：${format}` }
  if (!path) return { error: '没写取哪个字段' }
  return { format, path }
}

const KNOWN = ['json']

// 值必须是单行：命令行里的变量、边上的标签都放不下换行，所以在这儿就挡住。
function oneLine(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { error: '取出来是空的' }
  if (trimmed.includes('\n')) return { error: '取出来是多行的，放不进命令行' }
  return { value: trimmed }
}

// 入口：spec 是取法那段文本。要么 { value }，要么 { error } —— 一句话说清为什么取不到。
// multiline：出口上的字段可以多行（回话、评论）；提取节点 / 选路仍走默认的单行。
export function pickValue(text, spec, { multiline = false } = {}) {
  const { format, path, error } = parsePick(spec)
  if (error) return { error }
  const source = String(text ?? '').trim()
  if (!source) return { error: '来路没有值，先跑上游' }
  if (format === 'json') return pickJson(source, path, multiline)
  return { error: `不认识的格式：${format}` }
}

// JSON 的单字段路径（a.b.c）。取不到、对象/数组、空值都当错 —— 不静默给空值。
function pickJson(source, path, multiline) {
  let data
  try {
    data = JSON.parse(source)
  } catch {
    return { error: `不是合法的 JSON：${source.split('\n')[0].slice(0, 60)}` }
  }
  let cursor = data
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return { error: `没有「${path}」这个字段` }
    cursor = cursor[key]
  }
  if (cursor === null) return { error: `「${path}」是 null` }
  if (typeof cursor === 'object') return { error: `「${path}」是对象或数组，不能当值` }
  const text = typeof cursor === 'string' ? cursor : String(cursor)
  if (multiline) {
    if (!text.trim()) return { error: '取出来是空的' }
    return { value: text }
  }
  return oneLine(text)
}
