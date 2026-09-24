// 从 EXTENSION.md 正文里抽出某个输入 / 出口对应的那一段，给人看。
// 认标题带着这个名字（「留会话：…」、`` `ok` ``），或正文里出现 {{名字}} / [[名字]] / `名字`。

function splitSections(docs) {
  const sections = [{ heading: '', body: [] }]
  for (const line of String(docs ?? '').split(/\r?\n/)) {
    const hit = /^(#{1,6})\s+(.+)$/.exec(line)
    if (hit) sections.push({ heading: hit[2].trim(), body: [] })
    else sections[sections.length - 1].body.push(line)
  }
  return sections.map((item) => ({ heading: item.heading, body: item.body.join('\n').trim() }))
}

function headingHas(heading, name) {
  if (!heading) return false
  if (heading.includes(`\`${name}\``) || heading.includes(`[[${name}]]`) || heading.includes(`{{${name}}}`)) return true
  return heading === name || heading.startsWith(`${name}：`) || heading.startsWith(`${name}:`) || heading.startsWith(`${name} `)
}

function bodyHas(body, name) {
  return body.includes(`[[${name}]]`) || body.includes(`{{${name}}}`) || body.includes(`\`${name}\``)
}

function plain(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`+/g, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*+|~+/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text, max = 220) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'))
  return `${(at > 60 ? cut.slice(0, at + 1) : cut).trim()}…`
}

function tableRow(body, name) {
  for (const line of body.split(/\n/)) {
    if (!line.includes('|')) continue
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean)
    const head = cells[0]?.replace(/`+/g, '')
    if (head !== name || cells.length < 2) continue
    return plain(cells.slice(1).join(' · '))
  }
  return ''
}

function sentenceOf(body, name) {
  const marks = [`[[${name}]]`, `{{${name}}}`, `\`${name}\``]
  const parts = body.split(/(?<=[。\n])/)
  const hit = parts.find((part) => marks.some((mark) => part.includes(mark)))
  return hit ? plain(hit) : ''
}

export function noteOf(docs, name) {
  if (!docs || !name) return ''
  const sections = splitSections(docs)
  for (const item of sections) {
    const row = tableRow(item.body, name)
    if (row) return clip(row)
  }
  const hit = sections.find((item) => headingHas(item.heading, name)) ?? sections.find((item) => bodyHas(item.body, name))
  if (!hit) return ''
  const para = hit.body.split(/\n\s*\n/)[0] ?? ''
  return clip(sentenceOf(hit.body, name) || plain(para) || plain(hit.body) || plain(hit.heading))
}
