# Changelog

## 当前开发快照、月度计费与 Goal 续跑 — 2026-10-18

- 以 `46fad5d`（2026-10-15）为远端基线，保存当前 dashboard 开发源码与主仓库此前未推送的10项文件改动。
- 第4补丁 `0004-current-development.patch` 叠加旧3补丁；`config/snapshot.json` 核对完整开发源码hash。
- 新增 TPS、CNY主子分账、北京时间自然月与历史月份统计、模型排序及会话重命名入口。
- 保存 Goal 实时状态恢复、same-driver reattach、原目标 Resume、blocked 暂停、累计轮数预算ACK与修改总轮数入口。
- 保存可选 Hermes `0.1.0` 补丁、原始／目标文件hash与隔离目录应用脚本；不自动重启或启动目标，不计入默认13扩展锁。
- 增加21项CNY费率模板，仅含provider、模型ID与cost；手动合并，不覆盖现有模型配置。
- 同步1GiB小内存门槛与子代理运行约定；保留开发中的历史重放候选，不把源码快照等同部署或新机验收。
- 实际本轮检查结果见 `docs/VALIDATION.md`，旧日期条目保留当时发布边界。

## 阶段式后台主线监督与布局修复 — 2026-10-15

- 导出主线监管policy v2/cadence v1：方向与科学验收分开，仅准确偏离分支受限；新material与真正阶段checkpoint同时存在才自动审查，同阶段测试/记录/收尾不逐步调用模型。
- 保存只读fresh/async监督角色、受控嵌套边界、人工决定/精确短操作许可与证据完整性回归；现有分支放行不是尚未实现的持久人工流程裁决。
- 去除作者固定provider/model与机器路径，改为`PI_RESEARCH_SUPERVISOR_MODEL`显式认证模型；离线/实际public RPC/SDK no-model门禁分开，不发布私人研究状态或日志。
- 修复Subagents执行流与主会话长正文/URL/行内可点击路径溢出；长内容默认限高预览，支持「展开全文 / 收起」，代码/表格保留内部滚动。独立CSS/原生DOM增强不替换已有JavaScript与速度监控功能，无会话/服务重启。最终实际验证范围见`docs/VALIDATION.md`。

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
