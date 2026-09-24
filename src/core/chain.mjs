// 链：从入口出发，每一步都是「当前节点跑完，拿它的值挑一根执行出边」，走到走不下去为止。
// 出边不限根数、也可以回头指（环），所以这里是走路，不是拓扑排序。
// 最多走多少步是这份画布自己的设置（settings.mjs 的 canvas），由调用方读 —— 这里只管怎么走。
import { execOutAll } from './graph.mjs'

// 一步：拿 value 挑下一根。三种结果 ——
//   { to, label } 走这根（label 是它的标签，兜底边是空串）
//   { done: true } 没有出边，到头了（这就是「验收通过就结束」的表达方式）
//   { stuck }     有出边但一根都不匹配
// 先找标签相等的，再找空标签的兜底边。
export function routeFrom(graph, id, value) {
  const out = execOutAll(graph, id)
  if (!out.length) return { done: true }
  const picked = out.find((edge) => (edge.label ?? '') === value) ?? out.find((edge) => !(edge.label ?? ''))
  if (!picked) return { stuck: true, labels: out.map((edge) => edge.label).filter(Boolean) }
  return { to: picked.to, label: picked.label ?? '' }
}
