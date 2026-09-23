// 工作文件夹里的固定名字：存档、文本节点的 md、命令节点的缓存文件。
// 前后端都要用，所以单独放着，别在两处各写一遍。
export const CANVAS_FILE = 'mican.json'
export const DOCS_DIR = 'docs'
export const CACHE_DIR = '.mican'
export const CACHE_EXT = '.out'
export const LOG_EXT = '.log'

// 命令节点的缓存文件：一份对一个节点，名字由节点 id 推出（所以存档里不用存路径）。
// .out 是值（stdout），.log 是诊断（stderr）—— 后者只在节点上显示，不进值、不往下游走。
export const cacheFile = (id) => `${CACHE_DIR}/${id}${CACHE_EXT}`
export const logFile = (id) => `${CACHE_DIR}/${id}${LOG_EXT}`
// 出口的边车：挨着缓存文件，一份对一个出口。节点的值仍是那份 .out。
export const portFile = (id, port) => `${CACHE_DIR}/${id}.${String(port).replace(/[\\/]/g, '_')}${CACHE_EXT}`
