// 发行版的运行时入口：一个进程、一个端口，界面（dist/）与本地接口（/api/*）同源。
//
// 为什么不是 vite preview：它是 vite 的命令，而 vite 在 devDependencies 里 —— 发行版不该背着构建工具跑。
// dev 下 vite.config.mjs 已经挂了同一个 api，这里只是把「谁来听端口」这一件事补上。
// api.mjs 是 connect 风格的中间件（req, res, next），所以「不是 /api/ 就 next」天然落到下面的静态文件上。
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createApi } from './api.mjs'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(APP_ROOT, 'dist')
// 默认只绑本机：单人自用，接口没有鉴权（能列目录、能跑命令），不该动不动就摊给整个局域网。
// 真要在别的机器上访问，走 SSH 隧道，别改成 0.0.0.0。
const HOST = '127.0.0.1'
const START_PORT = 5599
const PORT_TRIES = 20
// 双击启动时不该再让人去点一次浏览器：起来了就直接把界面推到他眼前。
// 传 MICAN_NO_OPEN=1 可以关掉（自己起服务、用别的浏览器看的时候）。
const OPEN_BROWSER = !process.env.MICAN_NO_OPEN

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

// 找不到就给 404，不回退 index.html：MiCan 没有前端路由，回退只会把打错的资源路径伪装成「能打开」。
function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('找不到这个文件')
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, `http://${HOST}`)
  const rel = decodeURIComponent(pathname) === '/' ? '/index.html' : decodeURIComponent(pathname)
  const target = path.join(DIST, rel)
  // dist 之外一律不碰：路径里带 ../ 的都在这句话上被挡掉。
  if (target !== DIST && !target.startsWith(DIST + path.sep)) return notFound(res)
  const body = await fs.readFile(target).catch(() => null)
  if (!body) return notFound(res)
  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
  })
  res.end(body)
}

// 端口被占就往后挪一个 —— 双击第二次、或者别的东西占着 5599，都不该让人去读报错猜。
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, HOST, () => {
      server.off('error', onError)
      resolve(port)
    })
  })
}

// 开浏览器：三平台各一条命令，参数用数组给、不过 shell —— url 是我们自己拼的，但也别养成拼字符串的习惯。
function openBrowser(url) {
  const [file, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] // 第一个空参数是 start 的「窗口标题」，不给的话它会把 url 当标题
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(file, args, { stdio: 'ignore', detached: true }).unref()
}

const api = createApi(process.env.MICAN_WORKSPACE)
const server = http.createServer((req, res) => api(req, res, () => serveStatic(req, res)))

// 界面是构建产物，不是源码：没 build 过就直说，别让人对着一个白屏猜。
if (!(await fs.stat(path.join(DIST, 'index.html')).catch(() => null))) {
  console.error(`没有找到界面：${DIST}`)
  console.error('先跑一次 npm run build，再启动。')
  process.exit(1)
}

let port
for (let i = 0; i < PORT_TRIES; i++) {
  try {
    port = await listen(server, START_PORT + i)
    break
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || i === PORT_TRIES - 1) throw error
  }
}

const url = `http://${HOST}:${port}`
console.log('MiCan 已启动')
console.log(`  地址      ${url}`)
console.log(`  工作文件夹 ${process.env.MICAN_WORKSPACE?.trim() || '没指定 —— 在界面里点「新建」或「打开」选一个'}`)
console.log('关掉这个窗口就是停掉 MiCan。')
if (OPEN_BROWSER) openBrowser(url)
