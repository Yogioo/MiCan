# pi cli 帮助文档

## 系统追加提示词
`pi --apend-system-prompt <MarkdownFilePath>`

## 切换MCP配置(拓展)
`pi --mcp-config <path> `

## 指定技能开关

### 关闭所有技能发现
`pi --no-skills`
### 追加加载技能
`pi --skill <skill folder path>`
### 支持结合使用
`pi --no-skils --skill <skill folder path>\
-- skill <skill2 folder path>` 

## 指定工具
### 白名单
`pi --tools read,bash,edit,write`
### 黑名单
`pi --exclude-tools ask_question`
### 全关
`pi --no-tools`
### 关闭内置保留拓展
`pi --no-builtin-tools`

### 内置工具名
read bash powershell edit write grep find ls

### Tips
--tools 是全工具的最终 allowlist，会覆盖 defaultTools；
--exclude-tools 在结果列表上再做减法。
CLI flag 只在启动时 生效，/mcp ... 是会话内命令。
