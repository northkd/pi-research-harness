# Changelog

## 当前可用版本源码补齐 — 2026-10-13

- 补齐9个dashboard运行源码差异及实际shared context-window函数，第三源补丁与29文件hash；不含暂停的B1/R4。
- 补齐pi-subagents嵌套async identity补丁、包版本/前后hash拒绝保护与MIT许可证。
- 补齐compaction/非模型thinking、四插件bridge、KB/systemd/loopback proxy及外部工具可移植模板。
- 保存路由与验收历史代码，不保存真实账号模型映射或历史记录，不新增自动后台调用。
- 保存Pi、13扩展和browser依赖锁；固定首次安装使用npm ci与manifest检查。
- 实际收录88个许可可核验技能及辅助源码、原许可证和逐文件来源/SHA256；另外20个仅盘点待许可核验。
- 增加显式捆绑技能发现／canonical复制入口，拒绝覆盖已有技能，明确外部reviewer工具仍须单独授权配置。

## 迁移核验与浏览器入口修正 — 2026-10-13

- 修正浏览器 MCP 模板启动入口：使用固定版本实际可执行的 `build/src/bin/chrome-devtools-mcp.js`，而非只导出库的 `build/src/index.js`。
- 增加路径契约断言和文件授权说明；不改本机运行配置。
- 修正固定版本扩展首次安装：显式安装13个npm包，并核对实际manifest版本；不再把跳过固定版本的更新命令成功视作安装完成。
- 明确克隆源码不等于完整迁移当前设备，模型之外仍有外部工具、技能、插件和私有状态差异。

## 科研功能深色图 — 2026-10-13

- README 增加用户确认的深色科研功能图，介绍子代理推理、复核、数值验证与授权后的服务器计算及结果回流。
- 保留实际原图 1672×941，注明非原生 4K、非实验记录；不改运行代码或 `v0.1.0` 标签。

## README 中文图片更新 — 2026-10-12

- 概念封面替换为中文标题与模块说明，明确标注非实际界面。
- 实际 dashboard 截图的隐私遮罩与公开静态说明中文化。
- 仅更新图片和文档；`v0.1.0` 标签保留原始代码快照，不重写已发布历史。

## 0.1.0 — 2026-10-12

- Preserve a sanitized, source-based snapshot of the usable Pi research environment.
- Release Feynman/ARIS evidence adapters, route and proof/review gates, workflow bodies and offline contract tests.
- Add portable isolated-agent startup/configuration scripts and pinned package templates.
- Preserve the actually deployed dashboard frontend/native bridge source patches with upstream commit/license and file hashes.
- Include last-user-message undo/edit extension with immediate busy refusal, not deferred execution.
- Separate credentials, local auth/model settings, research data, compiled runtime and paused unaccepted history-replay work from the release.
- Add redacted real dashboard images and a labelled conceptual cover illustration.

This is a developer snapshot, not a claim that every model, browser, HPC or
scientific workflow has been end-to-end validated on a fresh machine.
