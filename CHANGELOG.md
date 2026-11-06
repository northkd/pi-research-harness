# Changelog

## 模型速度口径与原生计时修正 — 2026-11-06

- 参考 CC Switch 的实际请求统计，分开首输出后的观测 TPS 与全程估算；分别采用 100 token / 100 ms、200 token / 1 s 的样本门槛。
- Pi 端使用单调时钟记录请求、首个有效输出和响应结束；计时关联实际持久化消息 ID，优先使用有效采集，再回退 SDK `durationMs` 或明确标注的旧日志估算。
- 均速限定同一 provider、model 和主/子 agent 类型；观测与估算分别加权，缺失计时保持未知，极慢正速率保留精度。
- 面板修正模型名称与速度错配，移除把历史均速当作实时 TPS 的展示；报告思考 token 但未观测到思考首输出时采用保守的全程估算。
- 缓存预热不重置正在跟踪的 assistant 计时；请求起点歧义保留未知，历史重放不生成新实测；失败记录保留实际用量与费用。
- Speed plugin 137 项、Harness 326 项、监督离线 64 项通过；覆盖层 632 个文件，完整类型检查仍有 61 条既有诊断、无新增。计时限制、扩展重载与验证范围见[模型测速说明](docs/model-speed/implementation.md)及[验证记录](docs/model-speed/validation.json)。本次没有发送付费模型测速请求。

## 目标委托与主 agent 上下文减负 — 2026-11-06

- 新增 `research_dispatch delegate`：主 agent 交代完整目标和约束，独立执行协调者负责拆分、跟进、复核与汇总，服务端沿用持久化依赖调度和真实结果契约。
- 根会话也纳入首次分发决策门控；有子任务运行时限制主 agent 重复读取材料。执行器不可用或已知工作区身份丢失时明确阻塞，不静默退回主 agent 批量执行。
- 默认模型回执最多 8 KiB，详情最多 16 KiB，保留失败与阻塞状态，支持记录版本校验的分页和未变更状态压缩；工作台记忆块最多 8 KiB，固定指导另计。
- 子会话启动提示保持在原生 16 KiB 上限内，完整任务仍持久保存并可按需取回；创建回执不再重复返回全量任务。只读约束沿协调者和后代继承，只能收紧。
- 子会话首次任务提示等待可信工作区登记，临时注册及关联失败不会提前消费提示。
- Harness 308 项、监督离线 64 项、原生定向 9 项、重新部署后的浏览器 29 项通过；类型检查仍有 61 条既有诊断，新增 0 条。合成测量只量化返回文本字节，不代表真实 token、费用或长任务完成率，见[减负实现说明](docs/autonomous-collaboration/context-offload.md)与[验证记录](docs/autonomous-collaboration/context-offload-validation.json)。

## 长任务授权、递归分发与协作画布 — 2026-11-06

- 原生横向、纵向滚动条改用主题低透明度颜色，保留悬停、键盘焦点及高对比度表现。
- 新增长任务授权面板、宿主私有的限时授权记录和实际文件门控接线；已加入工作区的协作会话共享范围，支持撤销、到期和阻塞记录，复用主线监督的确认流程。
- 增加持久化 `research_dispatch` 任务执行器，按依赖创建子会话、控制递归与容量、接收明确结果和通知父会话；修正只允许 lead 委派的旧指导，增加协作者执行前的计划门控。
- Multi-Agent 画布根据真实创建来源展示父子层级、创建者和导航；多轮 Subagent 直接在当前画布中动画展开，支持窄屏和减少动效设置。
- 修复研究后端发现忽略启动器 `PI_RESEARCH_LOOP_ROOT` 的问题，显式路径需验证对应扩展包。
- 扩展隔离原生部署、浏览器检查、权限与调度回归；具体证据及未验证范围见 [本次实施记录](docs/autonomous-collaboration/implementation.md)。本次没有运行真实付费模型或连续十几个小时的科研作业。

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
