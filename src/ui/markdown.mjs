// markdown 渲染：marked 解析 GFM + DOMPurify 消毒，唯一出口是 renderMarkdown。
import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.use({
  gfm: true,
  breaks: true, // 编辑器是纯 textarea，单个换行就当换行，避免「按了 Enter 却没换行」
})

export function renderMarkdown(text) {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text))
}
