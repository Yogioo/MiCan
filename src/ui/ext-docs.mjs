// 扩展的说明：画布上一个可拖的窗口，正文就是那份 EXTENSION.md。
import { renderMarkdown } from './markdown.mjs'

const el = document.createElement('aside')
el.id = 'ext-docs'
el.hidden = true
el.innerHTML =
  '<div class="ext-docs-head"><span class="ext-docs-title"></span><button type="button" class="ext-docs-close" title="关掉">×</button></div>' +
  '<div class="ext-docs-lead" hidden></div>' +
  '<div class="ext-docs-body md"></div>'

document.body.append(el)

const titleEl = el.querySelector('.ext-docs-title')
const leadEl = el.querySelector('.ext-docs-lead')
const bodyEl = el.querySelector('.ext-docs-body')
let placed = false

el.querySelector('.ext-docs-close').addEventListener('click', () => {
  el.hidden = true
})

el.querySelector('.ext-docs-head').addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) return
  const box = el.getBoundingClientRect()
  const dx = event.clientX - box.left
  const dy = event.clientY - box.top
  const move = (next) => {
    el.style.left = `${Math.max(8, Math.min(next.clientX - dx, window.innerWidth - box.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(next.clientY - dy, window.innerHeight - 48))}px`
    el.style.right = 'auto'
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

function place(x, y) {
  el.style.left = '0px'
  el.style.top = '0px'
  el.style.right = 'auto'
  const w = el.offsetWidth
  const h = el.offsetHeight
  el.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - w - 12))}px`
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 12))}px`
}

export function openExtDocs({ title, description = '', docs = '', x = 24, y = 72 }) {
  titleEl.textContent = title || '说明文档'
  const lead = description.trim()
  leadEl.textContent = lead
  leadEl.hidden = !lead
  const text = String(docs ?? '').trim()
  bodyEl.innerHTML = text ? renderMarkdown(text) : '<p class="ext-docs-empty">这份扩展的 EXTENSION.md 没有正文。</p>'
  for (const link of bodyEl.querySelectorAll('a[href]')) {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
  el.hidden = false
  if (!placed) {
    place(x, y)
    placed = true
  }
}

export function closeExtDocs() {
  el.hidden = true
}

export const extDocsOpen = () => !el.hidden

const tip = document.createElement('div')
tip.id = 'port-tip'
tip.hidden = true
document.body.append(tip)

function showTip(target) {
  const text = target.dataset.tip
  if (!text) return
  tip.textContent = text
  tip.hidden = false
  const box = target.getBoundingClientRect()
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  let left = box.left
  let top = box.bottom + 6
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8
  if (top + th > window.innerHeight - 8) top = box.top - th - 6
  tip.style.left = `${Math.max(8, left)}px`
  tip.style.top = `${Math.max(8, top)}px`
}

export function hidePortTip() {
  tip.hidden = true
}

export function mountPortTips(root) {
  root.addEventListener('mouseover', (event) => {
    const target = event.target.closest('[data-tip]')
    if (target) showTip(target)
    else hidePortTip()
  })
}
