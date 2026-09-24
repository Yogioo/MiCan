# 打包

一次打包做完 = 每个目标平台各出一份压缩包，解压后双击脚本就起来，dev 下能干的（读文件、跑命令、装扩展）它都能干。

## 三个入口

| 命令 | 是什么 | 谁用 |
| --- | --- | --- |
| `npm run dev` | vite 起开发服务器，`vite.config.mjs` 把 api 挂成中间件 | 写界面时 |
| `npm start` | `server/serve.mjs`：一个 http，`/api/*` 交给 api，其余发 `dist/` | 跑成品时 |
| `npm run pack [目标]` | `scripts/pack.mjs`：组装出 `release/MiCan-<目标>/` | 出包时 |

`serve.mjs` 不碰 vite：它在 `devDependencies` 里，发行版不该背着构建工具跑。两个入口共用 `server/api.mjs` 那一个中间件，所以后端行为只有一份。

## 为什么没有编译

pack 不编译任何东西，只是把 node 官方的预编译包搬进 `runtime/`。所以**不必在目标平台上构建** —— 在 Windows 上也能摆出 mac / linux 的目录。

唯一的例外是最后压那一下：zip 存不下 Unix 的执行位，mac 的 `.command` 少了它双击不起来。所以 mac / linux 出 `.tar.gz`，且各在该平台上压（CI 里就是四个平台各跑各的）。

## 包里各就各位

```
MiCan-<目标>/
  MiCan.bat | MiCan.command | MiCan.sh   双击这个
  runtime/node[.exe]                     自带的运行时（连 node 的 LICENSE 一起）
  CONTEXT.md
  dist/                                  界面，vite 的产物
  server/                                后端
  src/core/                              server 依赖的那部分
  builtin/                               内置扩展库 + 工作文件夹的种子
```

**位置是有讲究的**，这几个都是靠 `import.meta.url` 往上退一级找文件：

| 找什么 | 谁在找 | 所以 |
| --- | --- | --- |
| `builtin/` | `server/extensions.mjs` 退一级 | 必须跟 `server/` 同级，少一层就找不到 |
| `CONTEXT.md` | `server/workspace-docs.mjs` 退一级 | 落在**包根**，不在 `builtin/` 里 |
| `src/core/` | `server/*.mjs` 写的是 `../src/core/…` | 必须带；`src/ui` 由 vite 打进 dist 了，不重复带 |

`CONTEXT.md` 是个特例：用语正文在仓库里只有一份、只在根上维护，`workspace-docs.mjs` 里那句 `if (name === GLOSSARY) return path.join(ROOT, GLOSSARY)` 就是从根取的。**漏了它，新建工作文件夹会当场 ENOENT** —— 而且只在真打包后现形，dev 下仓库根永远有那个文件。

包里没有 `package.json`：`.mjs` 自己就是 ESM，不需要它声明 type。带上反而让人以为要先 `npm i`。

## 加一个平台

三处一起改：`scripts/pack.mjs` 的 `TARGETS`（node 官方包的平台名、zip 还是 tar.gz、二进制在包里的位置、双击脚本叫什么）和 `LAUNCHERS`（脚本正文），再加 `.github/workflows/release.yml` 矩阵里的一行。

## 坑

- **Expand-Archive 会多套一层**：zip 里的顶层本来就是目录名，所以解到 `CACHE` 而不是 `unpacked`（tar 那条路解到同一处，落法才对得上）。
- **执行位**：跨平台组装时 tar 要加 `--mode=755`；bsdtar 不认这个参数，所以只在 Windows 上打时加。
- **`macos-15-intel`**：GitHub 的 Intel runner 标签会陆续退休，CI 报「找不到 runner」就来换一个。
- **没签名**：Windows SmartScreen 和 macOS Gatekeeper 都会拦一下，躲不掉，除非买证书。

## CI

`.github/workflows/release.yml` 四平台矩阵，每行跑自己那次 pack。打 `v*` tag 出正式 release，手动触发只出 Artifact。
