# 上游与许可证

本仓库只保存集成代码、配置模板和明确来源的定制，不重新打包所有第三方工具。

| 组件 | 快照版本 / 来源 | 本仓库如何使用 |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent@1.0.0` | 运行时由安装脚本单独安装，使用原许可证 |
| Dashboard | `@blackbelt-technology/pi-agent-dashboard@0.8.0` / [BlackBeltTechnology/pi-agent-dashboard](https://github.com/BlackBeltTechnology/pi-agent-dashboard) | 固定提交 + 两个源补丁；MIT许可证保存在vendor/licenses |
| Subagents | `pi-subagents@0.76.1` | 原生任务编排，独立安装 |
| Background tasks | `pi-background-tasks@2.6.9` | 原生完成通知，独立安装 |
| Feynman | `@companion-ai/feynman@0.5.22` | 文献工具与draft/review契约，独立安装 |
| Web access | `pi-web-access@0.35.0` | 搜索/fetch，凭据与provider由用户选择 |
| Scientific skills | `pi-scientific-skills@1.6.0` | 只加载配置模板所列技能 |
| MCP adapter | `pi-mcp-adapter@5.0.0` | 浏览器/服务工具网关 |
| Document parser | `pi-docparser@4.0.0` | 本地文档解析 |
| Remote tools | `@oresk/pi-remote-tools@0.2.1` | 用户授权的SSH目标 |
| Memory | `pi-memory@0.4.2` | 独立agent目录记忆，不发布真实memory |
| Context / code tools | `context-mode@1.0.169`、`pi-lens@4.3.0` | 使用原许可证；不输出认证配置 |
| Browser MCP | `chrome-devtools-mcp@1.10.1` | 可选，绑定用户专用Chrome的loopback CDP |
| Slurm MCP | [Charlie-Z-work/slurm-mcp-server](https://github.com/Charlie-Z-work/slurm-mcp-server) | 只记录来源，不复制本机SSH或作业材料 |
| ARIS | 用户另行安装的canonical skills | 本仓库只提供薄wrapper与历史契约目录，非上游技能全集 |

依赖的精确列表见 `config/settings.example.json`。包版本是本次快照使用的值，
不是“这些版本永远最新”或“所有新机都验证过”的承诺。

Dashboard固定源码提交：
`04985091706cb77d5e2f73bbf8b906966e9d97c7`。该源码要求 Node.js ≥22.19，
`packageManager` 为 pnpm 11.15.1；不要用不匹配的包管理器生成漂移锁文件。

原始代码与文档采用Apache-2.0；上游dashboard上下文代码保持MIT。
其他包在安装时附带自己的许可证，不因出现在本仓库依赖模板中变成Apache-2.0。
