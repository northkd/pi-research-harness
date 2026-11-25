# Pi Research 的终端与前端接口

替代宿主使用独立 Pi 安装，项目状态继续遵循现有的科研台账、会话身份和目标版本。新 UI 通过同源反代访问回环宿主，由反代注入宿主认证。WebSocket 使用单次连接票据。会话 MCP 使用单独的 Bearer 凭据。

| 前端操作 | 接口与结果 |
| --- | --- |
| 列表、恢复、停止 | GET /api/sessions 读取会话清单，POST /api/sessions 恢复原生会话。POST /api/sessions/:id/stop 返回 stopped 或 stopping。旧链接查询返回原生 ID，后续操作使用响应的 data.id。 |
| 会话归档 | GET /api/sessions/archived 读取归档清单，GET /api/sessions/archived/:id 读取详情。归档和取消归档使用 POST /api/session/:id/archive 或 /unarchive。 |
| 原生提示 | POST /api/session/:id/prompt 提交 text 和稳定的 promptId。收到 transmitted 才表示原生宿主确认接收。会话事件用于判断运行结果。 |
| 重连与确认 | POST /api/ws-ticket 提交 {"scope":"browser"}，拿票据连接 /ws?ticket=...。发送 subscribe 并携带 sessionId 和已处理的 lastSeq。event_replay 补齐历史。extension_ui_response 使用该确认的 requestId。 |
| 大会话历史 | GET /api/sessions/:id/transcript 支持 limit 和不透明 cursor。大条目仍会显示 entryId，可通过 GET /api/sessions/:id/entry/:entryId 或 /tool-result/:toolCallId 分段读取。HTTP 202 时继续使用 nextCursor。GET /api/events/:id/:seq 读取独立宿主实际记录的事件。 |
| 工作台接入 | /api/res-workflow 提供课题状态。history-candidates、adoptions、participants、charter-binding 保留既有接入、来源确认、加入和目标版本更新。接入分析的 HTTP 202 要继续读取 adoption 的状态。 |
| 派发、队列与回执 | /api/res-workflow/dispatch、collaboration 和 communication。使用稳定 planId 或 requestId，读取具体任务的 sessionId 与 registration。queued 表示排队，pending 或 unknown 表示原生注册尚待核实。 |
| 活动和证据 | GET /api/res-workflow/workbench-sync 按可见会话汇总真实运行。Science 接口保留独立宿主的可用状态和已核验产物。 |
| 文件和附件 | /api/file、/api/file/tree、/api/file/raw、/api/file/write 和 /api/sessions/:id/attachments/:digest。范围与项目准入一致。写回提供 mtime CAS，改变后须重新读取。 |
| 新建项目和固定目录 | POST /api/browse/create-project 接收 name，返回可直接用来开会话的 path。GET /api/pinned-dirs 读取固定目录。PATCH 接收 action 及 path 或 paths，供固定、移除和排序。 |
| 目录授权和 Pi 信任 | GET /api/access/grants 读取已有授权。根据拒绝响应中的 denialId 和 subject 或 ancestors 提交 POST。DELETE 接收 subject 和 scope 并撤回授权。/api/access/pi-trust 读取已核实的镜像状态，PUT /api/access/pi-trust/choice 保存选择。 |
| 会话模型和设置 | GET /api/models 读取本机模型目录。GET /api/sessions/:id/models 或 WebSocket request_models 读取已运行会话的模型选项。/api/model-defaults 保存默认模型，/api/pi-settings 使用 baseEtag 更新 Pi 设置。 |
| 模型服务商和 OAuth | /api/providers 管理服务商和模型目录，支持 test 与按服务商 refresh。/api/provider-auth/status 读取凭据状态，/api/provider-auth/api-key 保存 API key。OAuth 从 POST /api/provider-auth/start 开始，通过 /api/provider-auth/flow/:id 查询、提交 input 或取消。 |
| 设置热加载 | 保存设置会启动原生热加载。GET /api/pi-settings/reload 可跟踪会话状态，reloaded 带有新扩展实例和实际加载设置的哈希。运行中或有待答请求时保持 pending。 |
| 提问与确认 | /api/questions 读取托管会话和已注册终端的待答问题。POST /api/questions/:id/answer 只有收到原生会话确认后才返回 transmitted。详情中的 acceptsImages 指示是否支持 images 数组，每张上限 5 MiB。普通托管确认也支持 WebSocket。 |
| 思考译文 | GET/PUT /api/thinking-translation/settings 按会话查询或保存授权，启用需要明确的物理模型和 consent。已订阅会话的 thinking_translation 帧只用于实时展示。 |
| ACP | GET /api/acp/agents 读取已配置驱动。从 POST /api/session/spawn 选择 agent，然后通过该会话投递提示和处理原生确认。 |
| Goals、知识库、计费、自动化、Flows | 延续既有接口路径。文件与业务状态写入后从对应读取接口回查。自动化当前的执行范围和下一步状态在响应及记录中可见。 |

工作台的首次分工走 Pi 的原生确认。新 UI 可以提交给主会话，再把对应确认应答交回同一会话。后续在同一目标、归属和权限内的派发使用原有授权。更新目标时提交当前绑定的修订版本和目标哈希。

会话原工作目录缺失时，列表和详情会返回 `cwdMissing: true` 和 `resumeAvailable: false`。可继续查看会话正文、工具结果和原生附件。恢复操作需要原工作目录。

任务完成、子进程退出和科研验收各有自己的状态。任务回执可在队列仍推进时送到主会话。自动回收需要确切的原生身份、持久报告和空闲证明。进程归属未知时保留原会话及任务记录。

工作台同步接口读取已经写入的结果，扫描原生历史由独立进程完成。`coverage.partial` 和 `coverage.reasons` 告知调用方哪些记录仍缺少证据，`updatedAt` 表示结果写入时间。

## 验证与切换

test/host.test.mjs 使用隔离回环服务验证实际 HTTP 和 WebSocket。用例覆盖原生 ID 恢复、派发与主会话回执、滚动释放名额、项目创建、授权撤销、确认框、重连和 ACP。独立测试使用本机 Pi 离线验证原生路径权限，并通过真实 Caddy 验证浏览器登录与票据转发。

原有密封历史计划绑定物理路径和文件身份。正式宿主配置保留原工作台根、访问模式目录、授权文件、Pi 信任记录和原生会话路径。备份可用于归档核对。

无前端部署时，经过认证的 HTTPS 根路径返回宿主健康状态。新 UI 接入同一个来源的 /api 和 /ws，即可复用现有登录与会话范围。旧 Dashboard 的内存事件序号随原进程结束，新界面从原生会话历史和独立宿主分配的事件游标开始。
