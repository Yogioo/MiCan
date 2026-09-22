// 设置窗口：两层配置都在这儿 —— 跟这台机器走的（后端存）和跟这份画布走的（进存档，由调用方收）。
// 每一项都写在 core/settings.mjs 的表里：这里只按表画（名字、单位、说明、默认值、范围全来自表），
// 加一项配置不用动这个文件。常用项直接列出，细枝末节收在「细节」里。
//
// 值从调用方传进来的当前设置读（machine / canvas 永远是完整的，没设过就是表里的默认值）——
// 别去用后端的回参：手感那些键后端不认识，没存过就不回。
import { CANVAS_FIELDS, MACHINE_FIELDS, shownFields } from '../core/settings.mjs'
import { attachBrowser, openModal, request } from './workspace-dialog.mjs'

// 一行：名字 + 控件（带单位） + 说明（说明里带上默认值，省得挨个去试）
function fieldRow(modal, field, value) {
  const wrap = document.createElement('div')
  wrap.className = 'set-row'

  const name = document.createElement('div')
  name.className = 'set-name'
  name.textContent = field.label
  if (field.hint) name.title = field.hint

  const control = document.createElement('div')
  control.className = 'set-control'
  let read
  let set

  if (field.kind === 'shell') {
    const select = document.createElement('select')
    const options = [['', '跟这台机器的默认'], ...field.options.map((item) => [item, item])]
    for (const [optionValue, text] of options) {
      const option = document.createElement('option')
      option.value = optionValue
      option.textContent = text
      select.append(option)
    }
    select.value = String(value ?? '')
    control.append(select)
    read = () => select.value
    set = (next) => { select.value = String(next ?? '') }
  } else {
    const input = document.createElement('input')
    input.className = 'modal-path'
    input.type = field.kind === 'path' ? 'text' : 'number'
    input.spellcheck = false
    if (field.kind !== 'path') {
      input.min = String(field.min)
      input.max = String(field.max)
      input.step = field.kind === 'number' ? 'any' : '1'
    }
    input.value = String(value ?? '')
    control.append(input)
    if (field.unit) {
      const unit = document.createElement('span')
      unit.className = 'set-unit'
      unit.textContent = field.unit
      control.append(unit)
    }
    read = () => input.value.trim()
    set = (next) => { input.value = String(next ?? '') }
  }

  const note = document.createElement('div')
  note.className = 'set-note'
  note.textContent = [...(field.hint ? [field.hint] : []), `默认 ${field.def === '' ? '空' : field.def}${field.unit ?? ''}`].join(' · ')

  wrap.append(name, control, note)

  // 路径：后面跟一个「浏览…」，面板撑满整行
  if (field.kind === 'path') {
    const { browseButton, browser } = attachBrowser(modal, control.querySelector('input'))
    control.append(browseButton)
    wrap.append(browser)
  }

  return { wrap, read, set }
}

// 一个分组（层里的「命令 / 界面 / …」，或展开的「细节」）
function groupBox(container, name, hint) {
  const box = document.createElement('div')
  box.className = 'set-group'
  const caption = document.createElement('div')
  caption.className = 'set-group-name'
  caption.textContent = name
  if (hint) caption.title = hint
  box.append(caption)
  container.append(box)
  return box
}

export async function askSettings({ current } = {}) {
  const modal = openModal({ title: '设置', okText: '保存', wide: true })
  const readers = []

  // 命令行可选的名字由后端给（认哪些名字是后端的事）；其余的项这里不需要后端
  let shells = []
  try {
    const remote = await request('/api/settings', {})
    if (Array.isArray(remote.shells)) shells = remote.shells
  } catch {
    // 拿不到就当只有一个「跟机器默认」
  }

  // 一层：机器 / 画布
  const layer = (title, note, fields, values, which) => {
    const box = document.createElement('div')
    box.className = 'set-layer'
    box.innerHTML = '<div class="set-layer-title"></div><div class="set-layer-note"></div>'
    box.querySelector('.set-layer-title').textContent = title
    box.querySelector('.set-layer-note').textContent = note
    modal.body.append(box)

    const items = shownFields(fields)
    const common = items.filter((field) => field.tier !== 'advanced')
    const advanced = items.filter((field) => field.tier === 'advanced')

    const fill = (container, list) => {
      for (const field of list) {
        const spec = field.kind === 'shell' ? { ...field, options: shells } : field
        const row = fieldRow(modal, spec, values[field.key])
        container.append(row.wrap)
        readers.push({ field, layer: which, read: row.read, set: row.set })
        // 「启动时打开的工作文件夹」不在这一层里画，见 MACHINE_FIELDS 的 tier: 'hidden'
      }
    }

    for (const group of [...new Set(common.map((field) => field.group))]) {
      fill(groupBox(box, group), common.filter((field) => field.group === group))
    }

    if (advanced.length) {
      const more = document.createElement('details')
      more.className = 'set-more'
      const summary = document.createElement('summary')
      summary.textContent = `细节（${advanced.length} 项）`
      more.append(summary)
      const inner = document.createElement('div')
      inner.className = 'set-more-body'
      more.append(inner)
      box.append(more)
      for (const group of [...new Set(advanced.map((field) => field.group))]) {
        fill(groupBox(inner, group), advanced.filter((field) => field.group === group))
      }
    }

    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'set-restore'
    restore.textContent = '恢复这一层的默认值'
    restore.addEventListener('click', () => {
      for (const item of readers.filter((reader) => reader.layer === which)) item.set(item.field.def)
    })
    box.append(restore)
  }

  layer('跟这台机器走', '存在用户目录里，换工作文件夹不变；不进画布存档', MACHINE_FIELDS, current.machine, 'machine')
  layer('跟这份画布走', '进画布存档，换个工作文件夹打开就跟着变', CANVAS_FIELDS, current.canvas, 'canvas')

  const submit = async () => {
    const next = { machine: {}, canvas: {} }
    for (const { field, layer: which, read } of readers) {
      const raw = read()
      if (field.kind === 'int' || field.kind === 'number') {
        if (!Number.isFinite(Number(raw))) {
          modal.error.textContent = `「${field.label}」得填一个数`
          return
        }
      }
      // 运行目录这类允许相对路径（“.” 就是工作文件夹），只有纯本机路径才必须绝对
      if (field.kind === 'path' && !field.allowRelative && raw && !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(raw)) {
        modal.error.textContent = `「${field.label}」要填本机绝对路径`
        return
      }
      next[which][field.key] = raw
    }
    modal.error.textContent = ''
    try {
      // 机器那一层交给后端存（它会把 cwd 这类规范成绝对路径）；画布那一层带回去由调用方收
      modal.finish({ machine: await request('/api/settings', next.machine), canvas: next.canvas })
    } catch (error) {
      modal.error.textContent = `保存失败：${error.message}`
    }
  }
  modal.ok.addEventListener('click', submit)
  return modal.promise
}
