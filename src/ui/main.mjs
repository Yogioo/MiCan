// 装配层：持有状态，把状态变更分发给各个界面模块。
import { createView } from '../core/view.mjs'
import { mountCanvas } from './canvas.mjs'

export const state = {
  view: createView(),
}

const subscribers = new Set()

export function subscribe(fn) {
  subscribers.add(fn)
  fn(state)
}

export function update(mutate) {
  mutate(state)
  for (const fn of subscribers) fn(state)
}

mountCanvas({
  getView: () => state.view,
  setView: (view) => update((draft) => { draft.view = view }),
  subscribe,
})
