import { defineConfig } from 'vite'
import { createApi } from './server/api.mjs'

// 默认工作文件夹：设环境变量 MICAN_WORKSPACE（不设就在界面里用「打开 / 另存为」指定）
const api = createApi(process.env.MICAN_WORKSPACE)

export default defineConfig({
  plugins: [
    {
      name: 'mican-api',
      configureServer(server) {
        server.middlewares.use(api)
      },
      configurePreviewServer(server) {
        server.middlewares.use(api)
      },
    },
  ],
})
