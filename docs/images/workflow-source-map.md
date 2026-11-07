# README 流程图：源码映射与保证边界

这三幅图描述当前仓库的实现结构，不是一次真实科研任务的运行报告。绘图基于文档分支起点 `b79930abc23c7f5a93bc61e83979b25a5219bdea` 的源码；节点、条件和箭头均由固定脚本绘制。图中的运行完成、主张支持、评审通过和发布授权是不同状态。

| 图 | 文件 | 负责说明 |
| --- | --- | --- |
| 01 | [项目实际运行结构](project-illustration.svg) · [PNG](project-illustration.png) | Pi 会话、两种协作方式、工具结果、正式记录和工作台观测回流 |
| 02 | [auto-research 执行顺序](research-capabilities-dark.svg) · [PNG](research-capabilities-dark.png) | 自动 Stage 1–3 的调用顺序、停止分支，以及主会话另行接续的 Stage 4–5 |
| 03 | [科学记录、评审与授权](evidence-review-loop.svg) · [PNG](evidence-review-loop.png) | 显式登记、两类 gate 的不同合同、用户授权和主线监督旁路 |

## 阅读约定

- 青色实线表示实际调用、返回后显式登记或持久化关系。它不承诺某个外部模型、SSH 主机或任务当前已经运行成功。
- 蓝色虚线表示读取和观测回流。工作台的执行拓扑和用量观测不自动产生科研结论。
- 金色表示可选入口、需要另行组织的工作或用户授权。Stage 4–5 的金色虚线不属于 `auto-research.js` 的自动调用链。
- 主会话直接调用工具、组织下一项任务和登记结果属于主 agent 的行为；工作流脚本中的 `runs.run` / `runs.all` 属于明确实现的编排。图不把前者伪装成无条件的后台流水线。
- 图中有意省略了协议握手、HTTP 代理和部分状态检查；下面保留会影响理解的真实边界。装饰用图例不代表执行边。

## 图 01：运行结构

绘图脚本的 SVG 节点和箭头带有 `node-*`、`edge-*` ID，可与下表对应。

| 箭头 / 节点 ID | 准确含义 | 源码依据 |
| --- | --- | --- |
| `cli-to-main`、`chat-to-main` | Pi CLI 和 Dashboard 对话均围绕真实 Pi 会话工作；切换工作空间视图不会另建 Pi 会话。CLI 本身来自安装的 Pi runtime，仓库通过扩展接入。 | [research-loop 扩展入口](../../extensions/research-loop/package.json)、[registerTool](../../extensions/research-loop/src/index.ts)、[WorkspaceNavigation](../../patches/dashboard-v0.20/overlay/packages/client/src/components/split/WorkspaceNavigation.tsx)、[SessionSplitView](../../patches/dashboard-v0.20/overlay/packages/client/src/components/split/SessionSplitView.tsx) |
| `dashboard` | 顶层视图顺序是「对话 / 研究工作台 / 智能体 / 文件 / Science」；目录入口尚无会话时，对话项显示「新对话」。这些视图不是五个自动科研阶段。 | [WorkspaceNavigation 的 `items` / `select`](../../patches/dashboard-v0.20/overlay/packages/client/src/components/split/WorkspaceNavigation.tsx) |
| `main-session` | `research_loop configure` 冻结 charter；后续 `log`、`claim`、`stage`、`run` 等由调用者显式选择。配置研究约定本身不启动模型，启动不要求预算额度。 | [index.ts：`configure` / `run`](../../extensions/research-loop/src/index.ts)、[workflow-launch.mjs：`spawnResearchWorkflow`](../../extensions/research-loop/src/workflow-launch.mjs) |
| `main-delegates`、`subordinate` | `subagent` 和 workflow 是父会话下的执行能力；自动编排明确调用角色任务。可用工具和安装包由当前 runtime 决定。 | [auto-research.js：原生运行与可选旧适配器](../../extensions/research-loop/workflows/auto-research.js)、[delegation-policy.mjs](../../extensions/research-loop/src/delegation-policy.mjs) |
| `main-creates-collaborator`、`top-level-session` | `research_session` 经 `/api/res-workflow/participants/spawn` 创建独立顶层 Pi 会话，加入父会话已经确认的同一工作台，并保留 parent session、role、stage、charter 和 adoption 来源。它不是 native subagent。 | [workbench-session-tool.mjs：`createResearchSessionTool`](../../extensions/research-loop/src/workbench-session-tool.mjs)、[research-session-service.mjs：`createResearchSessionService`](../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs)、[participants/spawn 路由](../../patches/dashboard-v0.20/overlay/packages/server/src/routes/res-workflow-research-session-routes.ts) |
| `main-direct-tools`、`subordinate-tools`、`collaborator-tools` | 会话或被委派角色使用实际可用的工具。SSH 必须有具体主机、路径、操作范围与已转交授权；不会因图中存在 SSH 节点就自动获得远程写权限。 | [research-numerics](../../agents/research-numerics.md)、[research-ssh](../../agents/research-ssh.md)、[research_session 子会话任务约束](../../extensions/research-loop/src/workbench-session-tool.mjs) |
| `return-to-explicit-record`、`write-ledger` | 结果返回后，由调用者显式登记真实尝试与主张。`.pi/research-loop/` 存放 `state.json`、`ledger.jsonl`、`events.jsonl` 等正式记录；评审轮次和 trace 路径在图 03 单独解释。 | [index.ts：`log` / `claim`](../../extensions/research-loop/src/index.ts)、[ledger.mjs：`rootDir` / `appendAttempt` / `upsertClaim`](../../extensions/research-loop/src/ledger.mjs) |
| `observation-source`、`observe-execution-records`、`workbench-sync` | sync 从独立的会话/native status 观测源读取已经加入工作台的 transcript、工具调用/结果元数据及 native run 状态，投影执行、关系、动作和观测用量。图中没有原始结果文件 → sync 的边；普通工具输出也不能自行冒充 native run 状态。 | [workbench-sync.mjs：`discoverWorkbenchScopes` / `createWorkbenchSyncCollector`](../../extensions/research-loop/src/workbench-sync.mjs) |
| `sync-to-dashboard` | 工作台读取 sync 观测；可显示运行关系、状态和覆盖信息。观察值和正式科研状态并存。 | [workbench-sync-server.mjs](../../extensions/research-loop/src/workbench-sync-server.mjs)、[res-workflow-routes.ts](../../patches/dashboard-v0.20/overlay/packages/server/src/routes/res-workflow-routes.ts) |
| `ledger-read-to-dashboard` | 工作台另外读取 `.pi/research-loop/` 的正式科研文件。该线绕开 sync 节点，不表示 sync 把 transcript 自动转成 claim。 | [adoption-service.ts：`RESEARCH_FILES` / `researchFiles`](../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/adoption-service.ts)、[ResearchPipelinePage](../../patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchPipelinePage.tsx) |
| `user-opens-science`、`science` | 用户从 Dashboard 打开独立 Science 查看通道；原生工作区/任务画面与产物 viewer 不需要 Pi 会话。图中没有 Pi → Science 自动派发边。 | [ScienceTabViewer](../../patches/dashboard-v0.20/overlay/packages/client/src/components/research/ScienceTabViewer.tsx)、[WorkspaceNavigation：`ctx.openScience()`](../../patches/dashboard-v0.20/overlay/packages/client/src/components/split/WorkspaceNavigation.tsx) |
| `science-view-to-dashboard` | 原生画面、查看状态和产物由 Dashboard 的 Science viewer 展示；蓝色返回表示查看结果，不表示 Science 任务被 Pi 自动安排。 | [ScienceTabViewer](../../patches/dashboard-v0.20/overlay/packages/client/src/components/research/ScienceTabViewer.tsx)、[science-viewer-routes.ts](../../patches/dashboard-v0.20/overlay/packages/server/src/routes/science-viewer-routes.ts) |

**物理路径与 UI 范围。** `review-round` 默认将 memory 写到 `review-stage/REVIEWER_MEMORY.md`，将轮次轨迹写到 `review-stage/traces/round-N.json`；它同时在 `.pi/research-loop/events.jsonl` 追加评审事件。`stageDir` 可以由调用者指定，不能把所有 trace 都画进 `.pi/research-loop/`。见 [reviewer.mjs：`reviewDir` / `memoryPath` / `tracePath`](../../extensions/research-loop/src/reviewer.mjs)。Science 实例列表、详情和观测状态位于研究工作台的「研究总览」/「全部看板」内部；顶层 Science 视图负责原生画面或产物查看。图将其简写为独立可选通道，没有把两种界面混为同一个实例列表。

**顶层会话不等于统一派发来源。** 图中的 `research_session` 边专指该工具保存的父会话和任务 provenance。UI 的阶段启动也可以创建并加入工作台的独立会话，但不能据此声称它与 `research_session` 拥有相同的 parent/role/stage 派发边；工作台切换视图更不会创建会话。

## 图 02：auto-research 的实际调用链

主要源码是 [auto-research.js](../../extensions/research-loop/workflows/auto-research.js)。下表行号按上述基准定位，后续修改以函数和语句为准。

| 箭头 / 节点 ID | 实际执行与停止条件 | 源码定位 |
| --- | --- | --- |
| `run-entry`、`admitted-run` | 主入口 `launchAuto` 先做 explorer 内存准入，再经原生 RPC 调用 workflow；缺少当前会话、native runtime 或内存余量不能当作启动成功。常规启动不注入预算桥，也不要求请求或尝试额度。 | [index.ts：`admitExplorers` / `launchAuto`](../../extensions/research-loop/src/index.ts)、[workflow-launch.mjs](../../extensions/research-loop/src/workflow-launch.mjs) |
| `explorers` | `runs.all` 为不同 angle 启动 fresh-context `research-explorer`，返回假设卡。代码含 6 个 angle；虽然参数上限为 8，当前 angle pool 不会产生 8 个不同角度调用。 | `ANGLE_POOL`；125–141 行 |
| `cards-to-screen` | `research-critic` 把假设卡当作未验证材料，检查可证伪性、证据缺口及增量性。 | 143–155 行 |
| `screen-to-plan` | `research-strategist` 同时收到原始 cards 和 critic 的筛选输出，选择方向并产生带 executor、kill criteria 的结构化 milestones。该箭头不表示原始 cards 被 critic 改写后才可进入计划。 | 157–175 行 |
| `return-plan` | `stopAfter === 'plan'` 返回 `planned`；没有结构化计划则返回 `blocked`。 | 177–178 行 |
| `plan-to-experiments`、`milestones` | 对 chosen milestones 按顺序 `await`；executor 只在 `research-numerics` 和 `research-ssh` 之间选择，SSH 的授权边界仍由角色/实际工具控制。 | 180–199 行 |
| `return-experiments` | 任一 milestone 的结构化 status 不为 `completed`，工作流停止并返回 `blocked`；全部完成且 `stopAfter === 'experiment'` 时返回 `experiments_completed`。 | 199–203 行 |
| `experiments-to-review`、`critic-review` | 默认继续 Stage 3；每轮调用 fresh-context `research-critic`，输入相同 experiments 和上一轮 memory。 | 205–223 行 |
| `review-to-memory`、`memory-to-next-round` | 评审返回 score、verdict、weaknesses、fixes、memory；未收敛且未达到轮次上限时再次评审。循环体没有执行 fixes、修改文件、重新跑实验或调用第二种 executor 的步骤。 | 224–231 行 |
| `return-review` | `score >= 6` 且 verdict 为 `ready` 或 `almost` 时返回 `converged`；否则最多 4 轮后返回 `max_rounds_reached`。缺少必要结构化结果可能返回 `blocked`。 | 227–235 行 |
| `main-session-continuation`、`summary-to-optional-writing` | 结果回到主会话后，可以另行执行 Stage 4 总结和 Stage 5 可选写作。Stage mapping 是组织与产物约定，并非当前自动脚本会生成这些文件的证明。 | [stage-role-skill.json：`autoPipeline.stages`、Stage 4/5](../../extensions/research-loop/stage-role-skill.json) |

### 自动运行的实际前置条件

当前 [`agents/`](../../agents/) 发布 10 个角色模板，**没有** `research-explorer`、`research-strategist`、`research-reframer`。自动脚本直接引用前两者；reframer 出现在策略/映射中，但不是上述默认自动链路的阶段。`scripts/configure.mjs` 的角色安装只复制现有 `agents/*.md`，不能声称安装本仓库就已自动补齐这三个角色。调用前应确认缺少的角色已经在实际 Pi 环境中定义，并且相关模型与 native subagent 包可用。见 [角色复制逻辑](../../scripts/configure.mjs)、[自动脚本引用](../../extensions/research-loop/workflows/auto-research.js)。

入口的内存准入保留约 1 GiB 余量，并给出本次 explorer 数量；这不是所有会话、工具和外部进程的全局并发锁或硬内存隔离。`maxMilestones` 默认 2、上限 6；`maxRounds` 默认 4、上限 4。自动任务的步骤事件还区分 `executionStatus` 和 `businessStatus`，不能仅凭 native 调用结束就标记某次实验完成。

### standalone Stage 3 与 auto-research Stage 3 的区别

两者都会传递 reviewer memory，均**不会自动执行 fixes**；两者的 `converged` 都不是 `review-gate accepted`，更不是 `claim-gate accepted`。

| 方面 | [stage3-review.js](../../extensions/research-loop/workflows/stage3-review.js) | [auto-research.js 的 Stage 3](../../extensions/research-loop/workflows/auto-research.js) |
| --- | --- | --- |
| 评审对象 | 调用者提供 `task`；后续轮把调用时提供的固定 `changedFiles` 列表交给 reviewer | 自动链路产生的 chosen plan、experiments 与上一轮 memory |
| 结果解释 | 优先 structured output；否则尝试从 JSON / 文本解析 Score、Verdict | 要求存在 structured output |
| 阻断检查 | 检查 `review.ok === true`、非空分数和 verdict；失败返回 `blocked` | 循环显式检查 structured output 是否存在；不能把 standalone 的全部检查保证移植过来 |
| 文件修改 | 只传入 changedFiles 列表，不修改文件，也不在轮次之间产生新的 changedFiles | 没有应用 fixes 或重跑 milestones 的步骤 |
| 入账与 gate | 文件头和返回 note 明确要求主会话逐轮 `review-round` 后再 `review-gate` | 返回 rounds / finalMemory；脚本不调用 `review-round`、`review-gate`、`claim-gate` 或 `publish` |
| 模型独立性 | 可传 reviewerModel；真正的观测身份需要由调用者在后续记录时提供 | 可传 reviewerModel，步骤事件只在观察到一个实际模型时保存 observedModel；请求覆盖不等于实际使用 |

## 图 03：记录、gate 与监督旁路

| 箭头 / 节点 ID | 准确含义 | 源码依据 |
| --- | --- | --- |
| `raw-evidence`、`explicit-log-and-claim` | `log` 把行动、目标、预期、观察、教训和 evidence paths 追加到尝试账本；`claim` 更新主张记录。记录值来自调用者，工具不自行重跑实验。 | [ledger.mjs：`normalizeAttempt` / `appendAttempt` / `upsertClaim`](../../extensions/research-loop/src/ledger.mjs)、[index.ts：`log` / `claim`](../../extensions/research-loop/src/index.ts) |
| `log-claim` | 合法主张状态精确为 `supported`、`partially_supported`、`refuted`、`undetermined`、`failed`。`supported` 需要 evidence path，但一个路径本身不证明内容真实。 | [ledger.mjs：`CLAIM_STATUS` / `upsertClaim`](../../extensions/research-loop/src/ledger.mjs) |
| `record-review-path`、`review-round` | 主会话已经取得 reviewer 返回后，再提供 observedModel、response、changedFiles 进行记录；工具保存 trace 和 memory。轮次大于 1 时要求已有上一轮 memory 和 trace。 | [index.ts：485–514 行](../../extensions/research-loop/src/index.ts)、[reviewer.mjs：`recordRound`](../../extensions/research-loop/src/reviewer.mjs) |
| `trace-to-review-gate`、`review-gate` | 读取已登记轨迹，检查可见模型身份、与 authorModel 的区别、后续轮 previousDigest、响应摘要不重复以及收敛条件。返回 accepted / provisional / blocked。 | [reviewer.mjs：`gateReview`，179–207 行](../../extensions/research-loop/src/reviewer.mjs) |
| `record-claim-path`、`claim-gate` | 对已有主张和调用者提供的 jury、counterexample、obligations 进行内部验收字段检查；它与评审轨迹 gate 是两个入口，源码没有强制先通过 review-gate 再调用 claim-gate 的串行依赖。 | [index.ts：`claim-gate`](../../extensions/research-loop/src/index.ts)、[ledger.mjs：`gateClaim`，334–370 行](../../extensions/research-loop/src/ledger.mjs) |
| `accepted-to-user-authorization`、`publication-authorization` | 已有内部 accepted 后，`publish` 还需用户明确确认；保存该 claim 的 publication authorization。该操作不会提交论文、推送网站或执行其他外部发布。 | [index.ts：`publish`，440–456 行](../../extensions/research-loop/src/index.ts)、[ledger.mjs：`authorizePublication`，374–387 行](../../extensions/research-loop/src/ledger.mjs) |
| `checkpoint-to-supervisor` | 启用并冻结监督核心后，自动评审要求新材料与真实研究节点。节点类型为 plan_change、scope_change、stage_complete、drift_signal，并按 stage/kind 去重。普通编辑、测试、状态轮询或记账不能冒充新研究节点。 | [mainline-supervision/core.mjs：`recordCheckpoint` / `reviewEligibility`](../../extensions/mainline-supervision/src/core.mjs)、[mainline-supervision/index.ts：工具说明和调度](../../extensions/mainline-supervision/src/index.ts) |
| `review-to-scoped-policy` | 方向 verdict、科学支持和 reviewHealth 分别记录。只有具体事件/路径证据支撑的 OFF_TRACK 才可能限制相应操作路径；缺上下文、缺证据、审查失败不冻结整个项目。 | [mainline-supervision/core.mjs：评审结果记录](../../extensions/mainline-supervision/src/core.mjs)、[policy.mjs：方向与范围限制](../../extensions/mainline-supervision/src/policy.mjs) |

### 不把 gate 的检查范围写大

`gateReview` 对 author/reviewer 使用的是**模型字符串相等性**检查，不是完整的模型 family 独立性验证；后续轮检查 previousDigest 存在，而不是逐项重新验证全链哈希等式。正常 `review-round` 入口会从上一轮 trace 取摘要写入，图中的“核对轨迹”不承诺对任意被改写的 trace 做完整取证。`observedModel` 也需要调用者从真实调用结果取得，不是该 gate 独立查询模型服务。

`gateClaim` 的通过条件是：该 claim 有证据路径；至少两份包含 family 的 jury 记录、至少两个不同 family；若提供 authorFamily，则排除相同 family；`counterexample.status === 'completed'`；`unresolvedObligations` 为空。**函数不会读取证据文件、发起陪审团模型调用、运行反例搜索或验证所提供 family 的真实性。**它保存内部 acceptance，并在通过时将 claim 状态设为 supported；它验证的是登记契约，不能当作研究事实的自动证明。

`mainline_supervision pause/resume` 控制的是监督状态，并非自动暂停/恢复所有科研任务。`research_loop` 的 session-start 恢复逻辑主要恢复对已登记 run 的观察，不能据此保证所有任务跨进程重启继续执行。`narrow` 增加的是控制环 `phase`，不是自动推进五阶段中的下一阶段。相关实现见 [mainline-supervision/index.ts](../../extensions/mainline-supervision/src/index.ts)、[research-loop/index.ts 的 session_start 与 `narrow`](../../extensions/research-loop/src/index.ts)、[ledger.mjs：`appendNarrow`](../../extensions/research-loop/src/ledger.mjs)。

## 重绘与审查

脚本：[scripts/render-readme-diagrams.py](../../scripts/render-readme-diagrams.py)。从仓库根目录运行：

```bash
python3 scripts/render-readme-diagrams.py
```

可选参数 `--font /path/to/NotoSansCJKsc-Regular.otf`、`--output-dir /path/to/output`；也可用 `README_DIAGRAM_FONT` 指定字体。运行依赖为 Python 3.10+、Matplotlib、Pillow 和 Noto Sans CJK 字体。当前图由 Matplotlib 3.10.8、Pillow 13.0.0 与 `NotoSansCJKsc-Regular.otf` 渲染；不同字体/版本可能影响文字度量和文件字节。

脚本使用固定几何和文字、固定 SVG hash salt，并移除 SVG 时间戳。SVG 保留可编辑文字，需要查看环境具备相应 CJK 字体；README 的 PNG 已固化字形。PNG 宽度为 3840；三图源尺寸依次为 1920 × 1600、1920 × 1850、1920 × 1930。源图文字不小于 26 px，脚本检查文字越界、尺寸以及每个图文件小于 5 MiB，并在完整生成后替换输出文件。

后续维护应同时检查源码、图中文字、箭头和本文映射。单独修改模型名称、阶段数字或 UI 标签，不足以证明工作流已经变化。此文档更新和绘图过程没有启动真实研究模型、远程实验或 Science 任务。
