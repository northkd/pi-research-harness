# Multi-Agents 使用详细指南（`res-workflow`）

本文档说明 Pi Research Harness 当前版本的 Multi-Agent 协作机制：以 **`res-workflow` 工作台与「先 Plan 后 Work」** 为主线，包含 1:N `Plan ↔ Multi-Agent` 任务编排、Dashboard 前端四层同图内联拓扑与进度条，以及同 `plan` 兄弟代理横向通信协议（策略 A 三态）。

---

## 一、核心概念：Multi-Agent 与普通 Subagent 的边界

- **Multi-Agent** 是通过 `research_dispatch`（持久 DAG 调度）或 `research_session`（直连创建）启动的**独立顶级 Pi 会话**。每个 Multi-Agent 拥有独立 `sessionId`、独立的 token/费用统计、受工作台保护的 `cwd + ownerKey + charterHash + adoptionId` 绑定关系，以及跨进程重启仍可恢复的 `research_communication` 持久化信箱与回执账本。
- 若 Multi-Agent 自身需要扫代码、看日志或审核改动，它会在自己内部继续调用 **`subagent`（`L3 Subagent`）** 推进工程工作，从而保持主 Agent 上下文精简。

---

## 二、「先 Plan 后 Work」与 1:N `Plan ↔ Multi-Agent` 编排

### 1. 启动与接入

1. 在 Dashboard 打开研究项目页面（**Agents / 协作工作台**），在主控条中选择运行中的主会话，确认已绑定当前研究目标版本（`charterHash`）。
2. 通过主 Agent「发任务」框下发研究任务时，系统会自动附带 `【研究主 Agent 任务 · 先 Plan 后 Work】` 引导，要求主 Agent 先用 `research_dispatch`（`action: "plan"`）提交结构化 Plan，再按 Plan 分派与跟踪独立 Multi-Agent。

### 2. Plan 首次确认与滚动排队机制

主会话（lead）提交 `research_dispatch(action="plan", planId, tasks)`：

```json
{
  "action": "plan",
  "planId": "exp-ablation-v1",
  "tasks": [
    {
      "id": "baseline-eval",
      "role": "research-numerics",
      "stage": "2-experiment",
      "task": "复现并记录基线指标，输出相对证据路径 results/baseline.json。"
    },
    {
      "id": "theory-bound",
      "role": "research-theory",
      "stage": "1-idea",
      "task": "完成收敛上界推导与反例条件整理，输出 docs/bound.md。"
    },
    {
      "id": "critic-cross-check",
      "role": "research-critic",
      "stage": "3-review",
      "dependsOn": ["baseline-eval", "theory-bound"],
      "task": "交叉核查基线数值与理论假设一致性。"
    }
  ]
}
```

- **1:N 映射关系**：**1 个 Plan 可以对应 1 到 64 个 Multi-Agent 任务**（不要求 1:1），且主 Agent 可以按科研推进节奏提交多个先后 Plan（多个 L1 Plan 并列挂在 L0 主 Agent 之下）。
- **一次冻结确认，免逐批弹窗**：
  - 同一主会话在当前已冻结科研目标（`charterHash`）下首次调用 `plan` / `delegate` 时，前端/终端会弹出 **「确认首次科研分工」** 预览，清晰展示 `planId`、`charterHash`、任务数、并发、各条目的编号/角色/阶段/前置依赖与任务摘要；
  - 若被用户拒绝，主 Agent 收到 `research-dispatch-initial-plan-declined` 后按反馈调整再重提；并发重复首提会自动合流共享同一次确认；
  - 一旦确认，授权会持久化至会话记录，同一目标范围内的后续补位 Plan 与**各分支子会话在职责范围内的自拆解（branch decomposition）**不再重复打扰用户；仅当目标版本变更、扩大范围或触发外发/远程操作时重新确认。
- **全量队列与并发滚动补位**：
  - 按科研实际需要一次性把任务与 `dependsOn` 依赖图（单 Plan 上限 `64` 项，单任务依赖最多 `12` 项、任务说明上限 `4000` 字符）全部交给 `research_dispatch`，**不要用连发多次 `research_session` 代替队列**；
  - 系统先落盘整条 DAG 队列，再按实时并发配额自动拉起前置依赖已满足的任务，其余标为 `queued` 并在槽位空出后自动滚动补位：
    - 默认并发配额（`COLLABORATION_DEFAULT_LIMITS`）：主会话同时最多 **`4`** 个 Multi-Agent（工作台可调上限 `maxMultiAgents` 为 `8` 或系统总上限），每个协作节点同时最多 **`3`** 个 Subagent（可调上限 `maxSubagents` 为 `32`）。

### 3. `research_dispatch` 动作速查

| `action` | 适用方 | 说明 |
| --- | --- | --- |
| `plan` | 主会话或有权的分支拥有者 | 提交 1~64 项有依赖关系的结构化任务 DAG；重试同一批任务时保持同一 `planId` |
| `delegate` | 主会话 | 将大目标委派给独立执行协调者，由其拆分并管理后续子分支（按需选用，非强制） |
| `status` | 任意已加入会话 | 返回有界状态摘要（≤ 8 KiB），含本人 `assignment`、所属 Plan、同 `plan` 队友 `peers`；传入 `view: "detail"` 与 `planId`/`taskId`（或 `taskId: "self"`）可按 `nextOffset` + `recordHash` 分页拉取 ≤ 16 KiB 详单；上下文压缩后可用 `refresh: true` |
| `atomic` | 确实不可拆分的叶子协作者 | 记录“为何是单一不可拆任务”的具体 `reason`，放行后续工程执行 |
| `report` | 由 dispatcher 派发的任务 | 上报自身终态 `completed` / `failed` / `blocked` + `summary` + 项目内相对 `evidence` 路径；*注：`direct-worker`（直接 `research_session` 无 dispatcher 任务者）使用 `research_communication` 的 `report`* |
| `pause` / `resume` / `cancel` | 发起者或用户限制联动 | `pause` 暂停拉起队列中新任务（进行中任务继续）；`resume` 恢复排队拉起；`cancel` 取消指定 Plan 的后续调度（不强杀已运行进程） |

---

## 三、Dashboard 前端视图与交互指南

前端已将 **Plan 进度** 与 **调度拓扑** 对齐到最新的工作流模型：

### 1. 主 Agent Plan 完成进度条

位于主控面板及拓扑图中 `L0 主 Agent` 卡片内部的 `ResearchMainPlanProgress`：
- **尚无 Plan 时**：显式提示「先 Plan 后 Work / 等待主 Agent 提交执行 Plan（再分派 Multi-Agent）」。
- **已有 Plan 时**：实时计算并展示：
  - 总 Plan 完成率：`endedPlans / totalPlans`
  - 总 Multi-Agent 任务进度百分比与计数：`endedTasks / totalTasks (%)`
  - 统一三态徽章计数：**进行中**（蓝）、**排队中**（橙）、**已结束**（绿）
  - 各个 Plan 的快捷定位胶囊：点击某 Plan 可高亮对应的拓扑子树。

### 2. 四层同图内联拓扑（不切换视图）

调度拓扑（`ResearchAgentCanvas`）固定按以下自上而下层级展开：

1. **`L0` 主 Agent**：当前选定主会话卡片，展示内置 Plan 迷你进度条与汇总指标。
2. **`L1` Plan 节点**：直接挂在发起它的会话之下（主打在 L0 之下，支持多 Plan 并行与分支内二级 Plan），标有 `1:N Multi-Agent` 映射徽章、三态计数条（进行/排队/结束）以及进度百分比条。
3. **`L2` Multi-Agent 节点**：每个 Plan 下对应的实际协作者会话与尚未拉起的队列任务卡片（含序号 `waitingReason`：如并发槽位排队 / 依赖前置任务），清晰标注三态：`进行中`、`排队中`、`已结束`，并在节点内显示前置依赖数量 `dependsOn`。
4. **`L3` Subagent 角色组** → **`L4` 多次执行（Runs）**：某 Multi-Agent 或主 Agent 调用的会话内子代理按角色分组展示，展开可见每一轮的具体耗时、token 用量与费用汇总。

**核心交互规则（原画布内联展开，不跳切弹窗页面）**：
- **点击 `L1 Plan` 卡片**：原地折叠或展开该 Plan 下的全部 `L2 Multi-Agent` 节点（及其挂载的依赖连线），**不会切换到别的界面**。
- **点击 `L2 Multi-Agent` 卡片**：原地展开或收起该节点内部的 `L3 Subagent` 角色列表。
- **点击 `L3 Subagent` 角色卡片**：原地展开 `L4` 历史执行轮次明细。
- **点击卡片右下角「详情与纠偏」**：弹出 `ResearchAgentDetail` 会话详情弹窗，用于查看完整对话/回执、发送纠偏消息或核对证据，而不影响底层画布布局。

### 3. 画布辅助功能

- **顶部过滤与快捷操作**：关键词搜索（按 Plan ID、Task ID、角色名、会话标题过滤）、`隐藏已结束` 开关、`收起展开` / `展开全部 Plan`、`图例` 说明弹窗（区分 `主 Agent → Plan`、`Plan → Multi-Agent`、`进行中`、`Subagent`、`依赖/排队/交接` 线型）。
- **画布导航**：鼠标左键拖动画布；`Ctrl / Cmd + 滚轮` 或工具栏 `+`/`-`/`适应画布` 缩放；键盘方向键平移、`Home` 适应全图、`Esc` 逐层收起当前展开节点。
- **并发配额与排队面板**：工作台顶部可调整并实时持久化当前 `Multi-Agent` / `Subagent` 并发数，排队中的任务会实时显示等待原因（容量排队或前置依赖阻塞）及序号。

---

## 四、同 `plan` Multi-Agent 横向兄弟通信（策略 A 三态）

当同一个 `plan` 中的多个 Multi-Agent 需要共享阶段性实验发现、对齐接口假设或询问轻量协作问题时，使用原生工具 **`research_communication`**，无需把所有信息全部绕回主 Agent 转述。

### 1. 合法邻居范围与发现方式

- 协作者调用 `research_dispatch(action="status")` 后，返回结果的 `peers` 字段包含本 `plan` 的同级协作者花名册（单次摘要受有界容量控制，最多保留 32 项）。
- **严格的同伴判定边界**：双方必须同时满足**同一 `dispatchId`（所属 Plan）、同一直接父会话 `parentSessionId`、同一届 `tenureId` 且同一已验证工作台作用域（`cwd` + `ownerKey` + `charterHash` + `adoptionId`）**。跨 Plan、跨父节点、已切换届次（tenure）或不同项目一概拒绝。

每个 `peer` 条目包含核心字段：
- `taskId`、`role`、`stage`、`state`（归一化三态）、`rawStatus`、`waitingReason`、`sessionId`（已启动时存在）、`communicatable`。

### 2. 三态通信行为规则（策略 A）

`researchDispatchPeerState`（`extensions/research-host/services/research-dispatch-service.mjs`）与通信服务对三种状态执行严格区分：

| 队友状态 `state` | 判定条件（原始任务/会话状态） | 点对点 `send`（`progress` / `decision`） | 点对点 `send`（`request`）与 `reply` | `to: "peers"` Plan 广播 |
| --- | --- | --- | --- | --- |
| **`in_progress`（进行中）** | 任务处于 `launching` / `running` / `recovery-required` 且会话未结束/归档 | **允许**，按 `sessionId` 或 `taskId` 投递；`decision` 会即时唤醒接收方，`progress` 静默留存信箱并进入 `status` | **允许**；`request` 即时唤醒接收方，对方必须调用 `reply(messageId=...)` 才能结案 | **收到消息**并生成各自独立确认回执 |
| **`queued`（排队中）** | 任务处于 `queued` | **允许**（仅限通过 `taskId` 发送）：记为**延迟异步备忘**（`deferred`），等该任务轮到槽位启动时随初始投递一并可见，**绝不唤醒也绝不改变排队顺序/插队** | **拒绝**：返回 `409 research-communication-peer-queued`，提示改为发送异步备忘或向 `parent` 升级紧急决策 | **收到延迟备忘**（同样不唤醒、不插队） |
| **`ended`（已结束）** | 任务已 `completed` / `failed` / `blocked`，或会话已 `ended` / `closed` / `archived` | **拒绝**：返回 `409 research-communication-peer-ended`，不可继续发送 | **拒绝**：返回 `409 research-communication-peer-ended`；未决问题须带新 `requestId` 向 `parent` 升级 | **自动跳过**（不生成错误，也不向已结束节点发信） |

### 3. 点对点与广播调用示例

```json
// 1) 向进行中队友发送需要答复的协作请求（支持 taskId 或 sessionId）
{
  "action": "send",
  "to": "baseline-eval",
  "kind": "request",
  "requestId": "req_align_seed_001",
  "summary": "请确认 baseline 评估使用的随机种子集与验证划分是否包含 split-B。",
  "evidence": ["results/eval_config.json"]
}
```

```json
// 2) 向排队中队友留存延迟备忘（必须填 taskId，kind 仅限 progress 或 decision）
{
  "action": "send",
  "to": "critic-cross-check",
  "kind": "decision",
  "requestId": "memo_metric_unit_001",
  "summary": "主线指标统一采用 mAP@0.5:0.95 百分比口径，请在启动审阅时按该口径复核。"
}
```

```json
// 3) 向本 Plan 全部队友广播进展或决策（自动投递进行中+排队中，跳过已结束）
{
  "action": "send",
  "to": "peers",
  "kind": "progress",
  "requestId": "bcast_dataset_hash_001",
  "summary": "已修复清洗脚本标签错位并更新数据哈希，后续对比请以 data/v2_manifest.json 为准。",
  "evidence": ["data/v2_manifest.json"]
}
```

> **广播硬性约束**：`to: "peers"` **仅允许**配合 `action: "send"` 与 `kind: "progress" | "decision"`；试图使用 `request`、`reply` 或 `report` 对 `peers` 广播均会被服务端明确拒绝。

### 4. 消息确认、循环上限与收尾保障

1. **`ack` 与 `reply` 分离**：
   - 使用 `action: "pending"` 分页读取待处理信箱（配合 `cursor` / `nextCursor`）；
   - `progress` / `decision` 类消息阅读处理完毕后调用 `action: "ack", messageId` 标记已处理；
   - **`request` 类消息仅靠 `ack` 不会结束**：接收方必须显式调用 `action: "reply", messageId, requestId, summary` 回答原请求（服务端会用原请求作为语义关联；在请求回答完成前，消息恢复机制会继续提醒处理）。
2. **8 条直接通信防循环上限**：
   - 同一对队友在同一个 Plan 内，双方往来的**点对点直接消息**（`send` 与 `reply`，双向合并计算）上限为 **8 条（即 4 个来回）**。
   - 第 9 条起服务端返回 `409 research-communication-peer-loop-limit`（不可重试），引导双方把分歧或未决问题升级给共同的 `parent` 裁决。
   - **`to: "peers"` 广播产生的投递副本不计入该 8 条点对点计数**，避免团队同步挤占双边深度讨论配额。
3. **`peerSettled` 防退休死锁机制**：
   - 若请求发起方或接收方中任意一方的任务或会话先进入终态（`completed`/`failed`/`blocked`/`ended`），所有未决点对点请求会自动标为 `peerSettled: true`。
   - 一方面，待处理的疑问依然保留在信箱中，供协作者随时汇总上报 `parent`；另一方面，**已结算（`peerSettled`）或仅 `progress` 的记录不再卡住发送方完成任务后正常退出**（见 `workbench-communication-tool.mjs` 与 `retirement-check.mjs`）。
4. **严格幂等、权限隔离与最终交付归口**：
   - 重试网络或工具异常时务必复用**相同的 `requestId`**，服务端按操作者、通道与指纹幂等去重；内容有修改则必须更换新的 `requestId`。
   - 横向队友间消息**绝对不能扩展任务范围、新增文件权限或豁免 `readOnly` / `noExport` 限制**。
   - 无论兄弟间协作如何充分，协作者的正式阶段结论与终态交付（`action: "report"`, `status: "completed" | "partial" | "blocked" | "failed"`）**永远只能发往 `to: "parent"`**。
