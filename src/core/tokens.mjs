// 命令里的输入 token：`{{名字}}` 取正文，`[[名字]]` 取文件的本机绝对路径。
// 「一个节点要哪些输入」只有这一个口径 —— 画布左侧的端口、变量替换、报错都用它。
// 单独一个模块，是因为 graph / vars / UI 都要用，而它谁也不依赖。
export const TOKEN = /\{\{([^{}]*)\}\}|\[\[([^[\]]*)\]\]/g

// 扫一遍：按第一次出现的顺序给出要哪些输入，重名只算一个。
// `[[ ]]` 里带空白的不算 token（那是 shell 语法，比如 `[[ -f "$f" ]]`），跟替换时的口径一致。
export function parseTokens(text) {
  const found = new Map()
  for (const match of String(text ?? '').matchAll(new RegExp(TOKEN.source, 'g'))) {
    const [, textName, fileName] = match
    const name = (fileName === undefined ? textName : fileName).trim()
    if (!name) continue
    if (fileName !== undefined && /\s/.test(name)) continue
    if (!found.has(name)) found.set(name, { name, file: fileName !== undefined })
  }
  return [...found.values()]
}
