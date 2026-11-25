下表记录删除前 Dashboard 的业务入口基线，分布在 HTTP、浏览器 WebSocket、Pi 扩展消息和 MCP 四处。它不是新宿主已经逐项实现的接口声明。新界面需要能调用对应业务能力，并以实际持久记录、原生会话事件或工具结果确认操作效果。接口存在性来自 2026-11-23 的本机源码检查，运行状态仍需切换验收。文末记录独立复核时的新宿主入口与具体缺口。

先完成会话收发和人工确认，再验收科研接续与队列，最后覆盖插件和文件操作。每个异步操作保留原会话、目标版本、请求 ID 和结果 ID。提交后查询同一请求或任务的结果，避免把 HTTP 接收成功当成工作完成。

| 优先级与用途 | 当前 HTTP 契约 | 新界面要确认的实际效果 |
|---|---|---|
| P0 会话清单、历史和附件 | `GET /api/sessions`、`/api/sessions/archived`、`/api/sessions/archived/:id`、`/api/sessions/:sessionId/retained-transcript`、`/api/events/:sessionId/:seq`、`/api/sessions/:sessionId/tool-result/:toolCallId`、`/api/sessions/:sessionId/entry/:entryId`、`/api/sessions/:sessionId/attachments/:attachmentId` | 同一原生 session ID 和 JSONL/metadata 被读取。翻页、断线后补读、附件引用仍能返回原数据。 |
| P0 创建和继续会话 | `POST /api/session/spawn`，`POST /api/session/:id/resume`，`POST /api/session/:id/prompt` | spawn 关联稳定请求、会话和真实进程。resume 的 `mode` 为 `continue` 或 `fork`，分别验证原历史接续和新历史分支。`joinResWorkflow` 的加入结果要有 metadata 与工作台证明。 |
| P0 会话控制 | `POST /api/session/:id/abort`、`/shutdown`、`/lifecycle`、`/rename`、`/archive`、`/unarchive`、`/model`、`/thinking-level` | 取消、停止当前轮后退出、重试和终止进程各按原动作生效。模型选择核对实际会话模型。归档与名称在重启后可读。 |
| P0 人工应答 | `POST /api/session/:id/extension-ui-response`；`GET /api/questions`、`GET /api/questions/:id`、`POST /api/questions/:id/answer` | 首次科研分工、权限、输入和确认请求能展示并回传到原请求。并发或重复应答只认一次。问题回答的 `transmitted` 可证明送达，后续会话事件确认继续执行。 |
| P0 科研状态和关联 | `GET /api/res-workflow?cwd=...`、`/connection`、`/charter-binding`；`POST /charter-binding`、`/participants`、`/reconnect` | 旧 cwd、owner、adoption、charter hash 和会话身份接续。已有目标与实验记录保留原字节。目标版本变化时按原规则重绑，旧分支的只读属性随其任务保留。 |
| P0 科研队列和协作 | `POST /api/res-workflow/dispatch`、`/participants/spawn`、`/communication`；`GET/POST /collaboration`；`POST /collaboration/native` | 全计划先持久化，再按 Main/Multi 与原生 subagent 名额推进。`pause` 后在跑任务可完成，恢复后排队任务继续。完成、失败、消息回执和最终汇总可在服务重启后验证。 |
| P0 接入已有研究 | `GET /api/res-workflow/history-candidates`、`/models`、`/adoptions/:id`、`/adoptions/:id/sources/:sourceId`；`POST /adoptions`、`/adoptions/agent`、`/adoptions/:id/analyze`、`/adoptions/:id/confirm`、`/adoptions/:id/cancel` | 历史选择、实际模型和材料授权绑定到同一草案。取消后没有科研启动。确认接入更新来源和绑定；已有台账继续使用原内容。 |
| P0 接入恢复和补充历史 | `POST /api/res-workflow/adoptions/:id/agent/authorize`、`/agent/budget`、`/agent/resume`、`/history-review/prepare`、`/history-review/analyze` | 验证原授权、检查点和请求 ID，外部结果未知时保留未知状态，恢复查询与重试遵循原契约。 |
| P0 进度与权限 | `GET /api/res-workflow/workbench-sync`；`GET/POST /access-mode`、`/task-permissions`、`/research-budget` | 新宿主提供真实 caller 的 owner/cwd/session 查询。同步 heartbeat 只在成功扫描后更新。当前 research-budget 以实际计数和兼容记录为准，当前实现对尝试数和请求数均无硬上限。 |
| P1 思考译文 | `GET/PUT /api/thinking-translation/settings` | 以 session、owner、明确模型和 `consent` 保存授权，撤销后停止发送。译文通过临时事件显示，原会话和未来上下文无译文写入。 |
| P1 原人民币计费 | `GET /api/speed-monitor/billing?month=YYYY-MM`，`GET /api/speed-monitor/stats?sessionId=...&month=...` | 同一历史集合与北京时间月份得到同口径月报和会话明细。实时统计由实际模型事件更新。 |
| P1 Goals | `GET/POST /api/folders/goals?cwd=...`、`PATCH/DELETE /api/folders/goals/:id?cwd=...`、`POST /api/folders/goals/:id/sessions?cwd=...`、`DELETE /api/folders/goals/:id/sessions/:sid?cwd=...` | goal 的 objective、criteria、status、budget、judge、autoRespawn 和会话关联按原记录保存。需要验证 judge 与自动恢复的运行效果。 |
| P1 KB | `GET /api/kb/stats`、`/config`、`/search`、`/sources`；`POST /reindex`、`/source-trust`；`PUT /config`；`DELETE /source-trust`，均携带原 cwd 范围 | reindex 返回真实 job 后索引内容发生对应变化。search 返回 SQLite 原记录。配置写入、远程源信任和撤销按原检查生效。 |
| P1 Automations | `GET /api/plugins/automation/list`、`/runs`、`/result`、`/definition`、`/actions`、`/trigger-kinds`、`/git-capable`；`POST /create`、`/update`、`/run`、`/stop`；`DELETE /api/plugins/automation` | `scope`、cwd、name 绑定原定义，`runId` 绑定真实执行和结果。重启后触发器继续工作，run/stop 真正影响原运行。定义文件在 `<scope>/.pi/automation/<name>`。 |
| P1 Flows | `GET /api/plugins/flows/flow-inputs?cwd=...&flow=...`、`/files?sessionId=...`、`/file?sessionId=...&path=...`，另有下述 WebSocket 动作 | 实际目标会话接收 `flow:run` 或管理命令，读取 engine 已报告的精确 flow/agent/handler 文件。已部署源码明确记录部分 intent 实时广播尚未接好，验收按当前真实能力建立基线。 |
| P1 文件和编辑器 | `GET /api/browse`、`/api/file`、`/api/file/tree`、`/api/file/raw`；`POST /api/file/write`，以及现有 PDF、sheet、email、图表等读取路由 | 目录与文件准入继续按真实 cwd 校验。保存使用读取时的 `mtime`，写后核对新 mtime、size 和内容。并发版本变化返回冲突。 |

WebSocket 的浏览器入口是 `/ws`。旧契约通过 `POST /api/ws-ticket` 获取绑定 `browser` scope 的短时单次 ticket。新界面可采用新宿主的等价传输，但要覆盖以下消息和恢复语义。

| 浏览器发送 | 必需的接收与持久效果 |
|---|---|
| `subscribe { sessionId, lastSeq? }`、`unsubscribe`、`history_backfill` | `event { sessionId, seq, event }`、`event_replay { events, isLast }`、`history_window`、`history_backfill_result`。从上次序号补读，避免丢内容和重复显示。 |
| `send_prompt { sessionId, text, images?, delivery? }` | 原生 prompt 接收与实际生成事件。delivery 的 `steer` 与 `followUp` 继续对应原队列语义。 |
| `spawn_session`、`resume_session`、`abort`、`stop_after_turn`、`retry_session`、`shutdown`、`kill_process`、`force_kill` | 对应 spawn/resume/control 结果和 session_added/updated/archived 等事件，并核对真实进程状态。 |
| `request_commands`、`request_models`、`request_providers`、`set_model`、`set_thinking_level` | 真实 commands/models/providers 列表及 model_update 等确认。 |
| `extension_ui_response { sessionId, requestId, result?, cancelled? }`、`prompt_response { sessionId, promptId, answer?, cancelled?, source }` | 关联 `extension_ui_request`、prompt 请求、dismiss 和原生后续执行。人工确认通道与普通模型输入分别保留其来源。 |
| `flow_management { sessionId, action, flowName?, task?, description?, enabled? }`、`flow_control` | run/new/edit/delete/set-edit-mode，以及 abort/toggle_autonomous/dismiss_summary 的目标会话效果。 |
| `plugin_action { pluginId: "flows", sessionId, action, payload }` | `flow.run` 发到 engine 的 `flow:run`，`flow.new` 发出管理 skill 命令。其它 repo 已使用插件动作按其现有语义处理。 |

本机 `~/.pi/agent/mcp.json` 配置了 `http://127.0.0.1:8000/mcp`，protocolVersion 为 `2026-07-28`。部署的 MCP 插件还挂载 `/mcp/observe` 与 `/mcp/control`，每次请求验证 Bearer、版本和工具权限。相关工具包括 list/send/spawn/resume/shutdown/archive/rename session、set_model、set_thinking_level、prompt_response、Goals、Automations 和文件读取。科研工作台、思考译文和 KB 管理在原工具 denylist 中，需要继续由人工界面和专用工具授权。

部署和回滚依赖需要在切换时一起改接。

- Caddy 的 HTTPS 入口使用 Basic Auth，向 `127.0.0.1:8000` 转发，并移除原 Authorization 后注入本机 token。workbench-sync 有单独 handle。原 Basic Auth、session owner 与 MCP Bearer 的处理需分别核对。新宿主凭据应在切换时重新生成并同步给反代与本地客户端。
- `pi-research-dashboard.service`、`pi-research-dashboard-https.service` 和 `pi-research-workbench-sync.service` 目前由用户 default target 启动。新的宿主和新前端需要替换对应启动项与依赖，sync 的 dashboardOrigin、adoptionDir 和 stateDir 一起更新。
- 原生 JSONL 及 `.meta.json`、子会话目录、项目 `.pi/research-loop`、项目 KB 原地保留。迁移清单复制 Dashboard 私有状态、消息队列、会话预留、Goals 和附件。项目的 cwd/owner 哈希和授权范围继续使用原身份。
- 旧历史和接入记录中存在旧 attachments/res-workflow 的绝对路径。full-history-material 还把原 privateDir 和 sealed 文件的 dev/ino/mtime/ctime 纳入身份校验。新宿主直接接管原 `~/.pi/dashboard/res-workflow` 物理目录，保留旧 sealed 来源和检查点。当前备份只证明字节一致。迁移 sealed 运行目录需单独实现有证据的重建与兼容校验。
- 旧身份密钥、配对注册、token 和进程恢复记录以私有文件归档。新宿主生成新 token。旧进程记录用于核对，正式接管需要验证实际 PID 与会话身份。
- 队列切换时，先停止旧调度与同步写入，再作校验快照，启动新宿主。新旧宿主各自在自己的临时数据副本验证。恢复旧宿主前，先停止新写入，核对新产生的队列、消息与会话记录再回迁。
- 当前进程文件在此沙箱内指向不可见 PID，用户 bus 也受限制。正式停写与后台任务盘点需要主机级检查。源码和静态文件检查无法建立这个事实。

主要源码位置如下，均以仓库根目录为基准。

- `dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/routes/res-workflow-routes.ts` 的 249–335 行
- 同包 `src/routes/res-workflow-research-session-routes.ts` 的 109–305 行，`src/session/session-api.ts` 的 147–915 行
- 同包 `src/routes/session-routes.ts`、`src/questions/question-routes.ts`、`src/translation/thinking-translation-routes.ts`
- `dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/browser-protocol.ts` 的 1198–1238、1358–1740、2028–2089 行
- `dashboard/node_modules/@blackbelt-technology/pi-dashboard-mcp-server-plugin/src/server/tools.manifest.ts`、`tools.denylist.ts` 和 `routes.ts`
- `~/.pi/dashboard/plugins/goal/src/server/routes.ts`、`plugins/kb/src/server/kb-routes.ts`、`plugins/speed-monitor/src/server/index.ts`
- `dashboard/node_modules/@blackbelt-technology/pi-dashboard-automation-plugin/src/server/routes.ts` 和 `pi-dashboard-flows-plugin/src/server/index.ts`、`flow-files.ts`

删除验收要走新界面触发真实本地合成任务，从运行事件和落盘结果核对效果。只列按钮、返回固定成功文本或独立纯函数测试，无法确认前后端已接通。涉及模型的真实科研调用仍遵守已有材料和外发授权。

2026-11-23 新宿主独立复核检查点：上面的旧 WebSocket 动作不需要全部原样恢复。新前端应以 `host_capabilities.messages` 和下列真实 HTTP 操作为准。

| 业务能力 | WORKSPACE 中的新宿主入口与核对位置 |
|---|---|
| 历史翻页和事件补读 | `GET /api/sessions/:id/transcript?cursor=...`、`/api/sessions/:id/events?after=...`、`/api/sessions/:id/entry/:entryId`。JSONL 分页与事件序号是两种游标，分别保存；见 `api.mjs`、`transcript.mjs`。旧 `history_backfill` 消息不在当前 WebSocket 声明中。 |
| 创建、接续、控制、人工回复 | `compat/session.mjs` 的 `/api/session/spawn` 与 `/api/session/:id/...`；确认同时保留 `/api/questions/:id/answer`。新界面可用这些 HTTP 操作，再订阅原生事件确认效果。 |
| 实时显示 | 当前声明 `subscribe/resync/unsubscribe/send_prompt/extension_ui_response/abort`，以及 `request_models`、`science_view_*`。旧 `spawn_session/resume_session/request_commands/request_providers/flow_management` 不能作为新宿主现成消息发送；创建、接续、flow 操作用对应 HTTP 入口，原生命令可用 `/api/sessions/:id/command` 的 `get_commands`，providers/models 用配置与会话模型 API。 |
| 科研分工与接续 | `/api/res-workflow`、adoptions、charter-binding、participants、dispatch、collaboration、communication、workbench-sync 和 science 路由已进入宿主 router；用原 owner/cwd/session、目标版本和结果 ID 验证。 |
| Flows、Goals、Automations | 保留原 HTTP 定义与状态路由；另有 `/api/plugins/flows/control`、`/state`、`/api/plugins/goal/control`。原插件卡片布局、intent 渲染及终端组件属于旧 UI。真实运行仍须有 engine/会话的接收证据；旧部署也没有可用 receiver 的功能不能计为迁移后成功运行。 |
| 文件、附件和信任 | `compat/files/`、`compat/grants/`、`compat/pi-trust/`、`compat/workspaces.mjs`。保留读取范围、mtime 冲突、原附件身份与撤销效果。WordCraft 默认关闭；本机没有默认 PDF 引擎镜像，DOCX HTML 回退与 PPTX 明确失败属于已核实基线。 |

此次检查发现的具体缺口须在删除判断中单独核对，不能由“路由已移植”替代。

- 思考翻译：当前宿主尚未注册 `GET/PUT /api/thinking-translation/settings`，也未把原生 `THINKING_TRANSLATION_CHANNEL` 的临时帧送到新 WebSocket。只读计数显示原生授权目录有 2 条记录，2 条均启用。保留翻译包只能保证原生 CLI 的实现还在；新界面的授权、撤销和显示需要旧 auth/routes 与窄临时通道的实际接线。译文不得进入持久事件日志、会话或未来上下文。
- 大历史可发现性：分页目前跳过超过单条上限的 JSONL 行，只返回 `partial`，没有那一行的 `entryId` 引用。精确条目分块读取已经存在，但新界面仍需发现被跳过的大型 user/assistant/custom 记录；工具结果还需由 `toolCallId` 找到对应结果。最小补齐是有界 metadata/placeholder 与精确结果窗口，不应恢复全量读取几十 MB 历史。
- 问题摘要：人工回答已接宿主送达确认；`/api/questions/:id/summarize` 默认仍使用未配置的 `briefProvider`，并返回 unavailable。原默认 resolver 固定从 `~/.pi/agent/providers.json` 解析 `@fast`，此次只读检查该默认文件不存在，因此尚无原部署摘要可用的证据，不把它单独列为删除阻断。以后提供自动或手动摘要时，应接实际模型 resolver/complete adapter；人工回答仍按其原生送达结果验收。

本次沙箱看不到用户 bus，两个 loopback 健康探测也不可达，因此没有据此断言主机服务已停写或已切换。主机级代理、凭据、reload、附件与状态验收继续使用各自的真实检查结果。
