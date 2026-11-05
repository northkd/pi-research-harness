# Pi Research Harness UI 改版：功能保全独立审计

审计日期：2026-11-05。审计基准为 [设计基线](design-spec.md) 的 F01–F56，以及 Harness 原 `main` 提交 `af2810437b39772db62201b9f86346cdb9d62dfc`。审计对象是 `feat/research-workspace-ui-20261105` 交付工作树，包含新增 overlay 文件。

本文保留独立审查结论，并由主执行者合并最后一次构建、集成与浏览器验证结果；汇总见 [实施与验证](implementation.md)。本审计没有修改前端业务或服务端业务，没有启动真实模型任务，也没有连接生产 Science 或用户正在运行的研究进程。

## 1. 审计结论与证据强度

**当前差异以导航迁移、视觉重排、作者草稿保留及不准确显示的纠正为主，未发现为简化页面而删除原核心业务模块的证据。** F01–F56 均能映射回现存宿主、组件或处理器。尤其是原会话菜单、发送与队列、停止控制、专用文件 viewer、普通 Browser Done、Science 订阅边界及费用计算仍有原实现承接。

追加后端路由复核发现：原 main 已存在的 workbench-sync 隔离缺口和 backend root 查找协议失配，在独立纯基线源码中同样造成 **2/2 路由集成测试失败**。这些服务端实现不属于本轮 UI 修改，也未在本轮修复。因此本报告不能作为“后端跨用户隔离已全部通过”的依据；详见第 10 节。

这里的“保留”不能等同于“全部外部服务都已端到端验证”。本文按四种证据区分：

- **源码复用**：原组件、回调或数据计算仍在；对高风险模块另做了基准字节比较。
- **入口迁移**：入口改到主导航、折叠详情、项目工具或右侧详情，但仍调用原能力。
- **自动化实测**：实际执行了测试；React 单元测试中的网络、模型、PTY 或 Science 响应可能为 stub/fixture。
- **隔离真实 API 实测**：启动原生 Dashboard 服务并沿用原认证链，用明确标记的合成演示数据验证真实读 API。此类验证没有调用模型、注册活跃 bridge，不能证明生产后端的全流程行为。

“已注册插件”“有槽位”“有菜单”都不被视为“插件在用户部署上已启用且所有外部依赖可用”。保留启用条件、可用性判断、权限及原宿主生命周期，才是本次检查的对象。

## 2. 独立复核发现与处置

| 编号 | 发现 | 当前处置与发布含义 |
|---|---|---|
| A01 | 保留编辑缓冲后，`SplitWorkspaceProvider` 新增 `retainAuthoring` 默认 `false`；初次复核时真实 App 未传入，切回聊天会清空文件监听。 | 已立即告知主执行者。复核当前 `App.tsx` 的会话 Provider 已传 `retainAuthoring`；底层回归覆盖保留监听、磁盘变化与保存基线。最终生产构建已包含此接线；浏览器验证了跨主视图保留编辑草稿。 |
| A02 | 原准备流程只复制 `extras/speed-plugin`，native loader 默认扫描 `packages`、用户插件和 `resources/plugins`；仅前端 Vite alias 不足以注册费用 API。 | 隔离 runtime 用正式 bundled 发现路径 `resources/plugins/speed-monitor -> ../../extras/speed-plugin` 验证成功。主执行者新增幂等注册脚本和拒绝覆盖测试，不把 extras 插入 pnpm workspace。真实 stats/billing API 200，registry hash 状态 matched。该项为原部署链缺口的补齐，不涉及费用算法修改。 |
| A03 | 终端 keepalive 在关闭 split 后仍可能收到 `visible=true`，隐藏 pane 会保留无效 resize/聚焦状态。 | 当前 `TerminalPaneLayer` 把 `split.mode !== "closed"` 纳入可见性条件。新增真实 Provider + Layer 回归精确验证 `true → false → true → false → true`，全程单 mount，显式关闭才卸载并 kill。已通过。 |
| A04 | 非聊天主视图不含原 `TokenStatsBar`，费用入口可能随聊天区域或显示偏好一起隐藏。 | 当前 `WorkspaceNavigation` 增加共享会话费用入口及月报链接。`TokenStatsBar.showCost` 默认仍为 `true`；真实主壳显式传 `false` 去重。真实 session 才显示会话费用，目录视图提供月报，不冒充目录为会话。 |
| A05 | `research-typecheck.log` 全仓检查仍非零。 | 精确为 65 条诊断、6 个未改服务端文件；runtime、当前 overlay、冻结 overlay 和 Harness HEAD 四份字节一致。见第 7 节。不能表述为“全仓 typecheck 通过”。 |
| A06 | 代码审计时旧整合/浏览器日志有未关闭项。 | 旧 ResearchPanel 4 失败已由 `research-panel-final-tests.log` 的完整 7/7 通过替代；新增 FolderEditorView→DirectoryHomeView 真实路由集成组 42/42 通过，修正返回新对话前需保存 closed 的问题。最终真实浏览器 25/25 通过；已识别的 Monaco 取消事件及预期负向 API 返回完整保存在 browser-report.json，不计作未分类应用错误。 |
| A07 | 独立后端 route-isolation 检查 2/2 失败。 | 原上游 + af2810437 原 overlay/原测试的隔离临时 tree 同样 2/2 失败。第一处是既有代理隔离缺口；第二处是环境变量/安装 wrapper 与 resolver 查找协议失配。未删除断言、未修改服务端、未把该项计为通过。见第 10 节。 |

## 3. F01–F56 功能映射

下表中 `C/` 指完整运行树 `packages/client/src/`；在 Harness 中已有或新增覆盖文件位于 `patches/dashboard-v0.20/overlay/` 相同相对路径。`S/` 指 `extras/speed-plugin/src/`。测试组编号见第 6 节。标为“源码”的项目没有因此获得真实外部系统端到端通过结论。

| ID | 原能力及改后入口 | 保全方式与关键边界 | 已有证据／剩余范围 |
|---|---|---|---|
| F01 | 增加、切换和设置文件夹/工作区 → 左栏项目及原设置 | 复用 `SessionList` 原添加、目录导航、工作区操作回调；新折叠偏好只写浏览器 presentation key。 | 源码 + T1、T7；真实用户目录写操作未跑。 |
| F02 | 搜索、过滤、分组、已结束、归档 → 紧凑左栏/舒适模式 | 保留原筛选、headless 排除、分组和折叠逻辑；保留旧卡片密度恢复入口。 | T1；T8 用 3 个 ended fixture 验证真实会话列表读入。 |
| F03 | 普通/工作树新会话 → 原新建菜单 | 原创建分支、工作树选择、模型选择及可用条件保留，导航切换不会自动创建 Pi。 | 源码 + T1；不启动真实模型/工作树任务。 |
| F04 | 恢复、Fork、重命名、归档、关闭 → 会话原菜单 | `SessionActionsMenu` 与 `useSessionActions` 字节未变；紧凑卡片把直接按钮收至原菜单，并保留确认条件。 | T1；真正结束用户 Pi 进程未跑。 |
| F05 | OpenSpec 关联、变更、工作树 → 菜单/项目工具 | 原 actionbar、OpenSpec 子卡及可用性判断保留；BROKEN/STALE 提示在紧凑态仍可见并能展开详情。 | 源码 + T1；外部 git/OpenSpec 全流程未跑。 |
| F06 | 主对话、思考、工具、自定义消息 → 对话 | `event-reducer` 未变；执行记录折叠仍复用 `ToolCallStep`、原工具 renderer 和自定义行；失败与 ask_user 保持可见且不重复挂载。 | T1；流式模型网络未跑。 |
| F07 | 发送、队列、steering、后台 → 原输入区 | `CommandInput`、`useSessionActions` 保留；App 原 `wrappedHandleSend`、sessionId、images、draft 等接线仍在。 | 源码 + T1；真实 bridge 投递未跑。 |
| F08 | 停止、撤销并编辑 → 原输入/消息动作 | 原 abort、force-kill、undo/fork 回调及 live/read-only 条件保留；纠偏模板不伪装为进程停止。 | 源码 + T1；实际外部副作用无法撤回这一边界未改。 |
| F09 | 模型/provider/思考级别 → 输入与模型设置 | 原 selector、命令、设置写回路径未删除；卡片模型信息移入可展开详情。 | 源码 + T1；provider 实际出站请求未跑。 |
| F10 | 历史定位、Seek、恢复状态 → 会话头部 | `SessionHeader` 只去重布局切换入口，Seek、版本、刷新、恢复等保留；原 history/ChatView 接线未改。 | T1、T7；旧生产长历史未读入。 |
| F11 | 分屏、拖拽、65:35/50:50/35:65、全宽 → 布局菜单 | 复用 `useSplitState`、`LayoutModeSwitch`、divider，增加 keepMounted；不另造会话或编辑器状态。 | T2、T3、T7；最终浏览器覆盖 1920/1440/1100/768/360px。 |
| F12 | 冻结目标、真实阶段、控制环 → 工作台摘要/总览 | 复用 projection 和正式 state；`viewStage` 只筛选；实际阶段使用单独 aria-current/标签。 | T4；真实研究运行未触发。 |
| F13 | 五阶段独立会话和首条 Prompt → 工作流进度 | 入口仍先打开可编辑 Prompt，确认后原 API 创建；保留草稿，浏览阶段不产生 POST。 | T4；真实阶段模型任务未跑。 |
| F14 | 接续/新工作流指令 → 工作流进度 | 原指令生成、复制、启动确认路径保留，未把查看操作变成启动。 | 源码 + T4。 |
| F15 | 协作画布/列表/矩阵 → 智能体页 | 复用 `ResearchExecutionPanels` 三种表现；独立 Pi、原生子代理、workflow-step 分清，正式工作流记录有独立可达区。 | T4；大规模真实并发 Agent 后端未跑。 |
| F16 | 搜索、聚焦、缩放、分页、轮次 → 智能体画布 | 原 graph layout/pan/zoom 保留；隐藏时不以 0 宽覆盖视口；轮次按稳定会话+角色 key 追踪最新记录。 | T4；主执行者已实际查看协作、工作台、费用、文件、窄屏与深色截图。 |
| F17 | Agent 详情和原生完整会话 → 详情/原生会话入口 | 页面按真实 execution.id、workflowRunId/key 定位；名称/provenance 不同也保留被点击执行；原生 SubagentDialog 路径保留。 | T4；未使用真实在运行 subagent socket。 |
| F18 | 监督、文本纠偏、快捷模板 → Agent 详情 | 模板先填草稿；只有实际 sessionId 才可投递；只接受服务 `success && transmitted` 为已提交，显示 target、promptId/竞争回执；无目标不模拟成功。 | T4 + 原生 `/api/session/:id/prompt` 源码对照；真实纠偏投递未跑。 |
| F19 | 主张/证据/验收/反例/义务 → 主张与评审 | 保留 statement/status/evidence、jury 模型与族、verdict、counterexample、diagnostics、unresolvedObligations；增加 scope/decidedAt 展示。 | T4；不把任务结束解释为科学验收。 |
| F20 | 流程评审与发表授权 → 主张与评审 | 原 review-round/review-gate 裁决、轮次、观测模型和诊断保留；publication.authorized 独立标记为授权，非实际发表。 | T4。 |
| F21 | 尝试台账/动作/历史审计 → 历史与审计 | 保留原来源，最近 12 条之外新增查看全部 attempts/actions/reviews。 | T4；无历史服务数据迁移。 |
| F22 | 全部看板 → 工作台“全部看板” | 聚合 teams/workflow/overview/claims/audit 仍可打开；主导航独立 Agent 页不删除聚合模式。 | T4，新增工作台测试逐项断言。 |
| F23 | 目录/历史资料接入 → 资料接入与项目设置抽屉 | `ResWorkflowAdoption` 原实现字节未变，只迁移宿主；来源选择、计划、授权、预算、草案保留。 | T4；真实付费分析未启动。 |
| F24 | 历史复核/恢复 → 同一接入详情 | frozen history selection、版本覆盖、授权与恢复由原组件及服务处理；scope 重置边界保留。 | T4；真实 agent 恢复未跑。 |
| F25 | 成员关系/创建时加入 → 会话菜单/创建流程 | `ResWorkflowMembership` 和原创建路径不变；紧凑行仍显示成员身份与错误。 | T1、T4。 |
| F26 | 研究预算/观测用量 → 任务概览/总览与预算 | `maxAttempts` 标签改为“次”；响应/请求/token/尝试仍为各自字段，不与人民币混算。 | T4；真实计量写入未触发。 |
| F27 | 接入预算/无限制/补充授权 → 接入抽屉 | 原 policy-only update API 与组件保留；没有自动续期、重置或恢复付费任务；API Error 仅等价构造语法调整。 | T4；真实付费任务边界未联调。 |
| F28 | 来源原文/摘要/hash → 原来源 viewer | `ResearchSourceViewer` 字节未变；原 snapshot 引用、内容和完整性提示保留。 | T4。 |
| F29 | 会话费用与主/子分账 → 跨主视图共享费用入口/右侧详情 | `stats.ts`、价格、分账/去重等计算不变；保留全部筛选/明细；不完整金额显示 ≥，纯未知显示待定价。 | T5、T6、T8；不与真实账单对账。 |
| F30 | TPS/性能历史 → 同一详情面板性能标签 | 原实时/历史 hook 未改；面板左右边界和角落可调、可最大化，两个标签均保留挂载、滚动和筛选。 | T5；真实流式性能采样未跑。 |
| F31 | 月报/目录/会话/模型 → 计费统计及月报链接 | 原报表 API、北京时间月份、等价当前价格、聚合维度保留；视觉改为清晰列表/表格。 | T5、T6、T8；不把演示 usage 当真实消费。 |
| F32 | 文件树/编辑/标签/差异 → 文件 | 复用 EditorPane；Markdown/AsciiDoc/CSV 草稿和接入表单按 scope 保留；显式关闭释放，刷新只作用于目标文档。 | T2；浏览器实际打开 README-演示.md，并验证未保存编辑跨五个主视图保留、磁盘文件未被写入。 |
| F33 | 专用预览/plugin file handler → 文件原 handler | `viewer-registry`、`CappedViewer`、`PluginTabHost`、handler store 未重写；隐藏 pane 只令 handler inactive，不丢 dirty 实例。 | T2；所有外部插件真实交互未遍历。 |
| F34 | Shell/多终端 → 底部终端入口及原标签 | 原 `useTerminalPaneTabs` 与 TerminalView 生命周期保留；底部只调用原 open/create，保留 inline shell 回调。 | T3 + 源码；没有真的启动/杀死用户 PTY。 |
| F35 | 普通浏览器 relay/Done → 底部恢复入口及原会话 action | `BrowserPaneTab` 字节未变；没有把关闭 tab 改成 Done；插件宿主关闭/隐藏退出订阅。 | 源码与既有宿主测试；真实浏览器接管请求未联调。 |
| F36 | Science 原生画面与输入 → 主导航 Science/工作台入口 | 保留无 Pi 会话打开；inputOn 初始 false；原 lease、socket、scope、过期和帧条件检查未改。 | T4、T6；真实 Science 远程实例未接入。 |
| F37 | Science 实例及状态 → Science/总览 | 原 cwd/身份/新鲜度/覆盖不足逻辑保留，仅重排实例头部和控制；没有将注册信息视为活跃运行。 | T4、T6；生产实例健康状态未检测。 |
| F38 | Science 产物预览/原始下载 → 产物卡/专用 viewer | 真实 taskId/artifactId 解析、hash、版本和原始下载路径保留。 | T4、T6；真实外部 artifact 下载未跑。 |
| F39 | 自动化/Goals/Flows → 项目工具 | `SidebarFolderSectionSlot`、session flow/badge、content sticky 等宿主完整；折叠只隐藏展示。 | 源码 + T1；插件具备注册项不代表在用户部署上已启用。 |
| F40 | 知识库/MCP/OpenSpec → 项目工具/原设置 | 原 slot、配置和菜单路径保留，修复 deep-link 打开时展开新工具折叠层。 | 源码 + T1；真实索引/MCP 服务未调用。 |
| F41 | 角色/技能/记忆/团队等扩展 → 原插件管理/项目工具 | 原 registry 和 settings 路由仍承接；memory/flows/actionbar 等槽位未删。 | 源码 + T1；不承诺所有可注册插件已启用。 |
| F42 | 设置/主题/语言/显示偏好 → 设置和界面连接工具 | 原 theme、language、display prefs 未替换；新增密度为独立浏览器 key；sidebar width/collapsed 旧 key 继续读取。 | T1、T7，默认宽度与旧偏好恢复另有 hook 回归。 |
| F43 | 插件命令/徽章/tool renderer → 原宿主槽 | 13 类 Slot 组件、19 处 JSX 挂载点的静态数量与基准一致；工具详细输出仍经原 renderer。 | 源码 + T1；此计数是辅助证据，不等于每个外部插件 E2E。 |
| F44 | 后台 feed/订阅 → 壳层与原宿主 | `ShellHeadlessSlot` 等保持；新增项目工具/卡片详情折叠使用 hidden，actionbar portal 保持挂载；Science/Browser 仍按原退出规则释放订阅。 | 源码 + T1、T2、T6；不声称所有宿主永不卸载。 |
| F45 | 深链接/返回/旧 URL → 原路由链 | App 原路由分支整体搬到新工作区前，保留 frozen underlay 守卫；SplitRouteSync 与文件编码/历史返回仍在。 | T7；ResearchPanel 7/7 与目录返回对话 42/42 通过；浏览器重放旧 research/editor 深链接。 |
| F46 | 断线/重连/覆盖/过期 → 全局状态/详情 | 原 connection banner、generation 和 scope 保留；stale observation 不再冒充实时运行；lastActivityAt 不再当结束时间。 | T1、T4、T6；真实生产断线未模拟。 |
| F47 | follow-up 编辑/移除/提升/清空 → 原 QueuePanel | App 保留 normalizeFollowUpEntries 和四类回调；QueuePanel 与 useSessionActions 未改，文本编辑保留 images 的原处理。 | 源码 + T1；以实际代码为准，原注释中 display-only 描述不代表现在去掉了操作。 |
| F48 | Stop/Force Stop/Stop after turn → 输入/工具进程控制 | CommandInput 的三个不同回调全部保留；ToolStopControl 未变，群组停止的 controller 仍传给原运行项。 | T1；真实远程进程停止未运行。 |
| F49 | 后台进程/ProcessSafetyChip → 紧凑卡片/详情 | 紧凑且详情折叠时仍有 SessionActivityBar 和 ProcessSafetyChip；原 kill/navigate/session 范围不变。 | T1。 |
| F50 | Git/PR/工作树/完整 OpenSpec → 原菜单 | 原 SessionActionsMenu、MobileActionMenu 字节未变；保留 callbacks、disabled 原因、确认入口和插件 actionbar。 | 源码 + T1；没有创建 PR、提交代码或操作用户仓库作为 UI 测试。 |
| F51 | Pi 版本/Vault/tags/只读 phase → 头部/详情 | SessionHeader 内以上组件、Seek、标签和原读写边界保留，只有布局开关迁移。 | 源码 + T1、T7。 |
| F52 | 15 文件 viewer/7 类伪标签 → 专用视图 | OPEN_PATH_VIEWERS 15 项和 PSEUDO_TAB_VIEWERS 7 项仍在；registry 未改；terminal 仍是专用 keepalive 单 mount。 | 源码 + T2、T3；未把所有媒体格式逐个用生产文件打开。 |
| F53 | 搜索/Changes/磁盘变化/保存基线 → 文件 | 原 search 和 dirty guard 保留；新增 per-file refresh key、保留 buffer 关联 baseline、inactive shortcut guard、retainAuthoring watch。 | T2；A01 已补真实 App 接线。 |
| F54 | 终端创建/重命名/关闭/聚焦/限制 → 原终端标签和底部入口 | 原 rename/kill/auto-surface/focusOnMount/TerminalLimitNotice 保留；新增回归证明导航隐藏不 kill、不重复 mount。 | T3 + 源码；实际 PTY 资源限制未压测。 |
| F55 | 设置全目录/插件脏草稿保存 → 原 SettingsPanel | SettingsPanel 与插件 handler store 未变；没有用“常用设置”替换完整目录。 | 源码；插件自有保存事务未逐插件端到端重跑。 |
| F56 | 工作区排序/跨区移动/headless 过滤 → 左栏 | 原 DnD、排序、workspace map、过滤规则仍在；紧凑移动布局不额外启用桌面拖拽。 | T1；浏览器中的真实跨区拖拽仍按最终 QA 范围报告。 |

## 4. 高风险语义专项核查

### 4.1 会话菜单、队列和停止

对照 App diff，以下接线仍存在：`ChatView.onUndoLast` 的 live/read-only 条件；`QueuePanel` 的 edit/remove/promote/clearAll；`CommandInput` 的 send、abort、forceKill、stopAfterTurn、pendingPrompt/cancelPending、images、draft；`SessionHeader` 的恢复、Seek、tags、Vault、Pi version；原移动端 menu 及桌面 menu 的处理器。

紧凑卡片把部分按钮移入原菜单和“详情”，没有删除相应动作。ProcessSafetyChip 和需要注意的提示仍位于折叠区外。新增“执行记录摘要/详细”只写已有 `toolGroupDefaultCollapsed` 偏好；失败和 ask_user 绕过普通日志折叠规则，原有 toolDetails、images、原输出和插件 renderer 继续传递。停止的控制器仍依据真实运行项；快捷纠偏现在只是可编辑文字模板，不会冒充 abort。

### 4.2 插件槽位与启用状态

独立脚本提取了基准/现有 App、SessionCard、SessionList、SessionHeader 的 JSX Slot 名称和出现次数，**13 类组件、19 处调用，无删除或计数变化**：

- App：ShellOverlayRouteSlot ×6、ContentViewSlot ×2、ContentHeaderStickySlot ×1、ContentInlineFooterSlot ×1、ToastSlot ×1、ShellHeadlessSlot ×1。
- SessionCard：WorktreeCardSectionSlot、SessionCardActionBarSlot、SessionCardBadgeSlot、SessionCardMemorySlot、SessionCardFlowsSlot 各 ×1。
- SessionList：SidebarFolderSectionSlot ×1。SessionHeader：FooterSegmentSlot ×1。

静态计数只是防漏检查。进一步看了新折叠实现：项目工具和卡片详情使用 `hidden`；actionbar 的 detached container/portal 保留生命周期；没有根据“当前菜单是否打开”销毁 claim。SettingsPanel 及注册中心未被替换。原有 disabled、per-plugin visibility、会话/cwd 条件仍生效，因此不能把保留槽位表写成已启用插件清单。

speed-monitor 是这次唯一单独验证实际服务器加载链的例外：在无用户插件目录的临时 HOME 中，native bundled loader 加载成功，真实 stats 和 billing 路由返回成功。新 prepare 步骤遵守已有 loader 规则；未修改用户插件设置、未添加 workspace importer、未放宽访问控制。

### 4.3 编辑器、Science、Browser 生命周期

编辑器按 `sessionId + cwd + path` 保留有草稿的 authoring surface，而不是复制一套编辑器。显式 close 或 scope 切换释放；每个文档有独立刷新版本；基线校验与已载入缓冲对应，避免切回旧草稿时悄悄承认新的磁盘内容。file handler 的 store、guardDiscard、syncTabs 和 orphan/evicted 处理保留，隐藏 pane 改 inactive，dirty 实例仍由原 store 管理。

Science 不跟随 authoring surface 长期保留可见订阅。默认输入关；只有有效 lease、正确 scope/socket、未过期、有帧且手动开输入时才可发送。退出执行 `science_view_unsubscribe`，没有新增 terminate/delete backend 行为。普通 BrowserPaneTab 本身未修改，Done 仍针对原 takeover requestId，关闭浏览器视图不冒充用户已 Done。

独立终端测试只 stub xterm/socket 边界，使用真实 SplitWorkspaceProvider 和 TerminalPaneLayer；证明切换的是可见性而非重新连接实例。该测试没有实际连接或杀死 PTY，因此证明范围是 UI 生命周期及 kill callback 次数。

### 4.4 费用计算与研究计量

已逐字节比较以下计费模块：`S/server/stats.ts`、`S/server/index.ts`、`S/server/deepseek-pricing.ts`、`S/billing-period.ts`、`S/useSpeedStats.ts`，当前 overlay/runtime 均等于 Harness HEAD。月界、当前价格等价消耗、main/subagent 去重、cache read/write、按次计费、无定价/无效用量等原规则因此没有被 UI 改写。

变化在展示与布局：详情变为右侧可调整面板，可最大化；成本与性能两类明细保持；不完整已知金额带 ≥，全部未定价显示“待定价”；月报保留月份、目录、会话、模型维度。研究预算的 maxAttempts 按“次”显示，观测响应计数不会作为货币显示。T5 的原服务端 fixture 测试同时回归计算结果，而 T8 的演示 fixture 只用于确认“不知道价格”不会变成“免费”。

### 4.5 已核对不变的 22 个核心模块

下列当前 runtime 与对应基准字节相同；Harness 覆盖中存在的文件也与原 HEAD 字节相同。基准选择：原有 overlay 用 Harness HEAD；未覆盖的 upstream 文件用 runtime 固定上游 HEAD。

`CommandInput.tsx`、`hooks/useSessionActions.ts`、`QueuePanel.tsx`、`ComposerSessionActions.tsx`、`SessionActionsMenu.tsx`、`lib/chat/event-reducer.ts`、`ToolStopControl.tsx`、`MobileActionMenu.tsx`、`SettingsPanel.tsx`、`viewer-registry.tsx`、`CappedViewer.tsx`、`PluginTabHost.tsx`、`file-handler-store.ts`、`ResWorkflowAdoption.tsx`、`ResWorkflowMembership.tsx`、`ResearchSourceViewer.tsx`、`packages/browser-plugin/src/client/BrowserPaneTab.tsx`，以及上节列出的 5 个计费模块。

字节不变不能单独证明重新安放后的宿主正确，所以本审计同时检查了 App callbacks、Slot 宿主、文件/插件 hidden 状态、生命周期及相关回归结果。

## 5. 与原规格一致的语义修正

这些是明确的显示/交互改义，应在交付说明中列出，不能笼统声称“除了样式什么都没变”：

1. 预算次数不再加人民币符号；会话成本保持人民币/等价消耗原语义。
2. Pi 独立会话、native-subagent、workflow-step 分开；workflow-step 没有被删除，也不再充当原生子代理计数。
3. stale observation 优先显示过期，不再用绿色运行提示制造实时性；最后活动时间不当作结束时间。
4. 科学主张验收、流程评审、发表授权独立显示，任务“结束”不当作研究已通过验收。
5. 纠偏模板先填入草稿；无 sessionId 时不能投递；收到 transmitted 只称“提交到目标会话”，不声称 Agent 已执行或确认接收。
6. 静态/配置中的角色技能不再当作“实际用了这些技能”；实际工具观察有自己的来源与过期提示。
7. 用户手动收起的研究面板不会被每次状态更新强行展开；已访问表单保留草稿，隐藏时弹层从可访问导航中退出。
8. 历史默认仍为摘要，但新增“查看全部”，不能再将裁剪到最近 12 条的呈现描述为完整台账。

## 6. 已执行的验证及不能外推的范围

全部 Vitest 使用原 `npm run test:parallel -- --config … --root …` 隔离脚本；没有自行禁用 setup-home guard。以下为已读到的实际日志。各组存在重叠，**不可直接相加为互不重复测试总数**。

| 证据 | 实际结果 | 覆盖与日志 |
|---|---|---|
| T1 | 33 文件 / 665 测试通过 | `sidebar-chat-ui-final.log`；SessionList/SessionCard 原回归、新导航、ResizableSidebar、执行记录折叠、ask_user/失败输出、菜单和停止相关测试。 |
| T2 | 生命周期组 6 文件 / 93 通过；行定位补充 2 文件 / 27 通过 | `workspace-lifecycle-regression.log`、`workspace-line-navigation-regression.log`；dirty buffers、保存基线、handler inactive、快捷键、watch、refresh 与位置相关回归。 |
| T3 | 1 文件 / 1 测试通过 | `ui-terminal-workspace-tests.log`；本审计新增 TerminalPaneLayer.workspace.test.tsx；精确可见序列、单 mount、显式 close 才 kill。 |
| T4 | 最终整套 20 文件 / 181 测试通过 | `research-tests-final.log`；所有 research/__tests__ 加原 ResearchPipelinePage 测试。早期两项失败经修复后，最终全组重跑已通过。 |
| T5 | 7 文件 / 92 测试通过 | `ui-speed-tests.log`；speed-plugin 前后端已有用量/计费 fixture、month、pricing、hook、右侧详情与历史筛选。 |
| T6 | 4 文件 / 50 测试通过 | `ui-science-billing-tests.log`；ScienceViewer、ScienceInstances、ScienceArtifactViewer、BillingStatsSection。Science 项与 T4 重叠。 |
| T7 | 5 文件 / 108 测试通过；主导航补充 1 文件 / 6 通过 | `ui-shell-existing-tests.log`、`ui-navigation-final-tests.log`；SplitWorkspace/Context/RouteSync、原移动布局入口、DirectoryHomeView。与 T2 等组有重叠。 |
| T8 | 原生隔离服务、真实 API 与浏览器 25/25 通过 | `browser-report.json`；3 ended sessions、speed/billing API 200、无真实费用、原认证链成功、科研读 200 且 cwd 匹配，真实草稿保留和五宽度检查。已识别取消事件单列，不声称没有任何浏览器事件。 |
| T9 | Harness 233/233；监督离线 63/63，均无跳过 | `ui-harness-tests-final.log`；指定已准备 runtime 后包含阶段会话启动协议 fixture，含费用插件注册幂等/拒绝覆盖。 |
| T10 | ResearchPanel 整合 1 文件 / 7 测试通过 | `research-panel-final-tests.log`；更新旧首页预期，保留 deep-link/路由返回、同一 research DOM、阶段浏览、目录标签持久化；360px 概览开关，folder ID 不冒充 Pi 会话。替代旧日志中的 4 个失败。 |
| T11 | 目录返回对话回归 3 文件 / 42 测试通过 | `folder-conversation-regression.log`；从真实 FolderEditorView 路由返回 DirectoryHomeView 时保存 closed、composer 可见、重挂仍 closed、显式回到 editor 恢复 full。与 T7 部分重叠。 |

T8 合成数据明确标为“【演示】”：3 份合法 ended transcript，model/provider 是专用未定价 fixture，token/duration 是 UI 样本，不包含真实货币金额。真实原生 API 应返回 unpriced/incomplete；演示项目和 res-demo 的复杂 Agent 图也不能写成用户真实研究结果。

尚未以真实外部后端运行的范围包括：模型生成/收费、阶段会话真正启动、纠偏真正投递、队列到 Pi 的实际推进、Stop/Force Stop 对远程进程的效果、Science 原生分析/权限租约与外部产物、普通浏览器真实 takeover/Done、真实 MCP/索引、各扩展插件完整工作流。相关源码复用和 fixture 测试有价值，但不能替代这些部署验收。

## 7. 全仓 TypeScript 残留的精确归因

对 `ui-typecheck-tsc-final.log` 用 `^path(line,column): error TS…` 解析，得到 **65 条独立诊断，全部在 6 个服务端文件中**；续行解释不重复计数。没有把日志 83 行当成 83 个错误。

日志生成命令经执行者确认：在 `/workspace/scratch/1d62162ae33e/dashboard-ui-runtime` 根目录执行 `node_modules/.bin/tsc --noEmit --pretty false > /workspace/scratch/1d62162ae33e/research-typecheck.log 2>&1`。该次没有使用 `scripts/tsc7.mjs`；最终复跑宜保持相同编译器入口再比较诊断集合。

对每个文件比较了四份完整字节：

1. `git show af2810437b39772db62201b9f86346cdb9d62dfc:patches/dashboard-v0.20/overlay/<path>`。
2. 当前 Harness `patches/dashboard-v0.20/overlay/<path>`。
3. 冻结副本 `/workspace/scratch/1d62162ae33e/dashboard-baseline/overlay/<path>`。
4. `/workspace/scratch/1d62162ae33e/dashboard-ui-runtime/<path>`。

**六个文件均四份一致。** 当前 UI diff 未修改这些服务端业务文件。

| 文件（均在 packages/server/src/） | 诊断数 | 四份一致的 SHA-256 |
|---|---:|---|
| res-workflow/adoption-service.ts | 1 | `653eb38c64e5b20464f285e9189c00cc1f7921531ff921e921de9936f79efdab` |
| res-workflow/analysis-agent.ts | 27 | `fc03947fc7f29e8239bc83832690634d0449b08c72d0ad164d19881e18e23051` |
| res-workflow/full-history-material.ts | 16 | `3cfb6a1cfcf427800a69ef7bd5e4ef69fe13d724a695c70e478af43543cb4063` |
| res-workflow/full-history-review.ts | 14 | `8de5da84a429efeb9dd42d9b0b63c59bc3cbdf1902328aa25c9e4a47fce2303b` |
| res-workflow/local-history-stream.ts | 3 | `23359a8cba4b9c18f1d67eea12c626b24cc454ab5a8cb1bed675150fea1c85e3` |
| routes/res-workflow-research-session-routes.ts | 4 | `a71c70743b523e014cb11ec618334954a01e29e32d1eca6fe68f3b9abc4fa61b` |
| **合计** | **65** | — |

错误代码分布：TS18046 ×24、TS18048 ×19、TS2454 ×6、TS2345 ×5、TS2322 ×4、TS7006 ×2、TS2698 ×2、TS7005 ×2、TS7034 ×1。

较早 `baseline-typecheck.log` 有 88 条，最新 65 条全部已在其出现，新增诊断集合为 0，减少 23 条。但是该早期日志已经包含本轮新增 `SessionNavigation.workspace-ui.test.tsx` 等内容，**不能仅因文件名为 baseline 就称它是纯原 HEAD 重跑结果**。本审计能严谨证明的是：剩余 65 条处于未改源码，错误集合未新增；不能声称全仓 TS 已通过，也不能把减少的 23 条都描述成修复原 main 的历史错误。

## 8. 合并验收结果

- 最终前端与 team app 构建通过；真实 CLI 健康检查的 clientBuild 为 matched。
- 610 个 overlay 文件在固定上游干净工作树应用成功并 verify 无差异；正式 prepare 已接入 extras 注册。
- ResearchPanel 7/7、目录编辑返回对话相关 42/42 均通过；实际浏览器验证草稿、旧链接、文件树、Science 空态、费用入口和五个宽度。
- 最终浏览器逐项结果、准确的负向 API 合同和 Monaco 取消事件保留在 [browser-report.json](browser-report.json)。截图由主执行者实际查看，内容均为合成演示数据。
- 主题回归 3 文件、1139 项通过，新增最终 CSS 级联与主题 manifest parity；深色、自定义主题及 AA 阈值保持。
- 最终语法/发布检查及测试组记录见 [validation.json](validation.json)。没有将互相重叠的前端测试相加为一个总数。
- 后端路由隔离仍有原基线可重现的 2 项失败，详见第 10 节；全仓类型检查仍非零，详见第 7 节。没有删除原断言或改变服务端授权以制造通过。

## 9. 关键核查位置

- 导航和业务接线：`C/App.tsx`、`C/components/split/WorkspaceNavigation.tsx`、`SessionSplitView.tsx`、`SplitWorkspace.tsx`、`SplitWorkspaceContext.tsx`。
- 菜单与插件宿主：`C/components/session/SessionCard.tsx`、`SessionList.tsx`、`SessionHeader.tsx`；原 SessionActionsMenu、MobileActionMenu 和 SettingsPanel。
- 作者状态与文件：`C/components/editor-pane/EditorPane.tsx`、`EditorTabs.tsx`、`TerminalPaneLayer.tsx`、`file-handler/use-file-handler-pane.ts`、`C/lib/layout/editor-pane-state.ts`。
- 研究与来源：`C/components/research/ResearchPipelinePage.tsx`、`ResearchTabViewer.tsx`、`ResearchExecutionPanels.tsx`、`ResearchAgentDetail.tsx`、`ResearchAgentCanvas.tsx`、`ResearchClaimPanels.tsx`、`ResearchWorkspaceSummary.tsx`；未改 ResWorkflowAdoption、ResWorkflowMembership、ResearchSourceViewer。
- Science：`C/components/research/ScienceViewer.tsx`、`ScienceInstances.tsx`、`ScienceArtifactViewer.tsx`；普通浏览器 `packages/browser-plugin/src/client/BrowserPaneTab.tsx`。
- 费用：`S/index.tsx`、`S/server/stats.ts`、`S/server/index.ts`、`S/server/deepseek-pricing.ts`、`S/billing-period.ts`、`S/useSpeedStats.ts`、`C/components/settings/BillingStatsSection.tsx`。
- 安装可达性：`scripts/prepare-dashboard.sh`、`scripts/register-dashboard-extras.mjs`、`tests/dashboard-extras.test.mjs`、原 `packages/dashboard-plugin-runtime/src/server/loader.ts` 的 bundled 发现链。

审计依据当前源代码、实际 diff、字节对照和执行日志，未把旧 snapshot 文档当作当前实现。归档的类型诊断、路由基线复现及机器可读结果见本目录的 evidence/ 与 validation.json；原始运行目录路径仅表示本轮临时验证环境。

## 10. 追加：路由隔离测试的原基线问题

### 10.1 实际失败与基线重放

主执行者通过 `PI_RESEARCH_DASHBOARD_SOURCE=/workspace/scratch/1d62162ae33e/dashboard-ui-runtime bash scripts/test-dashboard-v020.sh` 运行既有集成脚本。`ui-route-isolation-final.log` 中实际只有 **2 个测试，0 通过、2 失败**：

| 测试 | 第一处失败位置 | 实际现象 |
|---|---|---|
| workbench proxy enforces workspace access and preserves remote identity | `tests/dashboard-route-isolation.integration.mjs:14` | 发往同步服务的请求缺少 `x-pi-caller-local`，断言得到 undefined 而非远端标识 0。 |
| dashboard can find the explicitly configured research-loop backend and refuses invalid paths | 同文件 `:23`，resolver `adoption-service.ts:165` | fixture 设置有效 `PI_RESEARCH_LOOP_ROOT` 后仍得到 503 `research-backend-unavailable`。 |

为区分 UI 回归与既有问题，另建隔离临时 tree：从 Git 原始对象提取固定上游 `65dc4558c7b07ef755ee4f0eda89d9f63e7e76e0` 源码，覆盖 `af2810437b39772db62201b9f86346cdb9d62dfc` 的原 overlay；原测试、启动脚本和 research-loop 扩展也来自该原提交。workspace 包链接指向这个临时 tree，只有已安装的第三方依赖被复用。执行同一脚本，结果仍 **2/2 失败且失败断言、错误码相同**。日志为 `ui-route-isolation-baseline.log`；临时 tree 已清理。

相关两份服务端文件在原 HEAD、冻结 overlay、当前 overlay、runtime 四份字节相同：

- `packages/server/src/routes/res-workflow-routes.ts`：SHA-256 `36b538c86af1b3bb5abac7a1a8b2e4e79cb23d71585c43369545bc91950efb0c`。
- `packages/server/src/res-workflow/adoption-service.ts`：SHA-256 `653eb38c64e5b20464f285e9189c00cc1f7921531ff921e921de9936f79efdab`。

既有 route-isolation 测试、`scripts/test-dashboard-v020.sh` 和 `bin/pi-research-dashboard` 也均与原 HEAD 一致。可以确定这两项不是本轮 UI 新增回归；不能据此忽略其对原功能完整性和隔离性的影响。

### 10.2 第一项不是单纯 header 大小写或旧测试断言

当前 `res-workflow-routes.ts:243–269` 为 workbench-sync 单独注册处理器，只检查 rawCwd 是否存在，未调用本文件其他科研路由使用的 `query()`、`accessFor()`、`execute()`。该处理器直接向 loopback 同步服务请求，仅传源码中固定的本地凭据头，没有传递原调用者分类及其 cookie/authorization，也没有在本处理器拒绝不可安全转发的 DPoP 请求。本文不记录该固定凭据的内容。

既有同步服务 `extensions/research-loop/src/workbench-sync-server.mjs` 明确要求 `x-pi-caller-local` 必须为 0/1，并为远程调用者只使用其原身份重新读取 Dashboard；所以二者协议本身已经不一致。当前集成测试在第一个缺头断言停止，后续“多余 path query 拒绝”“DPoP 拒绝”“已知 cwd 撤销后拒绝”并未运行到。按服务端源码判断，不能仅把此断言改为当前 header 名称就称隔离恢复。

代理失败后的 `resolveLocalWorkbenchSyncObservation` 同样直接接收 rawCwd；在没有调用统一 cwd/owner admission 的情况下，它不是合法的权限兜底。此处的修复需要针对原服务端隔离协议，不能通过移除测试断言、绕过 guard 或给失败响应伪造成功来完成。

### 10.3 第二项是 resolver、fixture 和启动 wrapper 的查找约定不一致

`adoption-service.ts:150–165` 当前只从 `import.meta.url` 所在目录向上最多 12 层寻找名为 `research-loop` 的真实目录；要求目录非符号链接，并通过受限读取 package.json 验证包名 `pi-research-loop-local`。**没有读取 `PI_RESEARCH_LOOP_ROOT`。**

与此同时，`bin/pi-research-dashboard:7` 仍导出该环境变量，默认指向 Harness 的 `extensions/research-loop`；集成测试 `:22–24` 也明确按“有效显式路径成功、无效显式路径失败”的协议验证。默认 `.runtime/dashboard-source` 和 `extensions/research-loop` 布局不会自动使扩展出现在 resolver 枚举的祖先候选中。

因此没有一条“只补 export”就能正确修复当前测试的命令。把扩展复制到偶然的祖先候选位置，只可能让第一次成功；由于无效环境变量仍被忽略，第二个拒绝断言仍不正确。符号链接候选本来就被拒绝，也不应为通过测试而取消该限制。

### 10.4 有边界的后续修复建议；本轮未实施

1. workbench-sync 复用已有统一 query/cwd/owner admission，确认授权后才代理；从原私有凭据读取工具获取 transport credential，不使用源码常量；根据认证层已经验证的身份分类 local/remote，保留允许转发的原用户身份。DPoP 不能安全重新绑定时继续拒绝，不降级为普通身份。保持固定 loopback 目标、有限超时和受限响应。
2. 任何本地 observation fallback 都必须经过相同 admission，并按真实 cwd/adoption/charter 与调用者可见会话裁剪；无法证明相同范围时返回不可用，不以未授权磁盘扫描作为兜底。
3. 明确 host-controlled backend root 协议。若继续支持已发布 wrapper 的 `PI_RESEARCH_LOOP_ROOT`，应在 resolver 中用同等绝对路径、真实目录、非符号链接、受限 manifest 校验处理它；显式值无效时失败，不能静默退回另一份 backend。若改由宿主注入 `researchLoopRoot`，应一起修改 wrapper/文档/测试，使协议一致。
4. 保留本次失败的隔离测试，并在后续服务端修复中让各拒绝分支独立成项，避免第一处断言阻止其他断言执行；再用真实原生认证链做受控本地验证。

以上是本次发现的已有后端问题和后续修复范围说明；当前 UI 分支未实施这些服务端更改。最终交付应报告“UI 功能迁移有对应证据；该独立路由集成门槛在原基线和当前均失败”，不能写作所有后端验收已通过。
