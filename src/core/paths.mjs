// 工作文件夹里的固定名字：存档、文本节点的 md、命令节点的缓存文件。
// 前后端都要用，所以单独放着，别在两处各写一遍。
export const CANVAS_FILE = 'mican.json'
export const DOCS_DIR = 'docs'
export const CACHE_DIR = '.mican'
export const CACHE_EXT = '.out'

// 命令节点的缓存文件：一份对一个节点，名字由节点 id 推出（所以存档里不用存路径）。
export const cacheFile = (id) => `${CACHE_DIR}/${id}${CACHE_EXT}`
