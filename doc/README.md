# Pi Research Harness：Subagents 与 Multi-Agents 使用手册

本目录详细说明当前版本（`main`）中 **Subagents（会话内受控子代理）** 与 **Multi-Agents（`res-workflow` 独立科研协作者与 Plan 调度工作流）** 的配置、路由规则、调用方式、团队通信协议以及 Dashboard 前端交互。

---

## 一、核心定位对比：什么时候用 Subagent，什么时候用 Multi-Agent？

| 维度 | Subagent（`subagent` 工具） | Multi-Agent（`research_session` / `research_dispatch`） |
| --- | --- | --- |
| **驱动底座** | `pi-subagents@0.79.2` | `extensions/research-loop` + `extensions/research-host/services` |
| **运行形态** | 隶属于当前父会话的子运行上下文 | 独立顶级 Pi 进程（拥有独立 `sessionId`、工作区登记、收件箱与生命周期） |
| **典型分工** | 多目录代码/日志并行检索（`scout`）、改动复核（`reviewer`）、隔离构建修复（`worker`）、外部检索（`researcher`）、高难证据核验（`evidence-auditor`）、计划一致性审查（`oracle`）、外部 CLI 咨询（`agy-advisor`） | 加入已确认 `res-workflow` 科研目标后的分阶段科研拆解、并行实验、跨模型交叉评审、独立探索分支 |
| **模型选择** | 通用工具角色由父 Agent 显式按三档配额顺位传入 `model`；专职 `research-*` 角色按会话/模型策略绑定；`agy-advisor` 先经用户确认模型与推理档位 | 按独立 Pi 会话模型配置运行；支持异构模型族交叉评审 |
| **编排机制** | 父会话直接按需单发/并发调用（`async: true`，建议单节点默认 3 槽位） | 严格遵循 **「先 Plan 后 Work」**：通过 `research_dispatch` 提交 1~64 项有依赖关系（`dependsOn`）的持久 DAG，自动排队补位 |
| **通信协议** | 子向父使用 `contact_supervisor`；完成结果回传父会话 | 纵向父子与横向同 `plan` 队友均使用持久消息工具 `research_communication` |
| **前端呈现** | 调度拓扑中挂在所属会话下的 **`L3 Subagent 角色组` → `L4 多次执行`**（同图内联展开） | **`L0 主 Agent` → `L1 Plan` → `L2 Multi-Agent`**（1:N 映射、实时三态、Plan 进度条） |

---

## 二、本次版本重点更新概览

1. **Subagent 首轮直开与目录扩容**
   - 通过 `patches/subagents/0013-advertised-catalog-upgrade-0792.patch` 将常驻广播角色上限由 `16` / `12 KiB` 扩展到 **`25` 个 / `20 KiB`**，仓库预设 `18` 个常驻角色（7 个通用角色 + 11 个专职角色）均可完整注入，不再触发目录截断。
   - 在运行时子代理配置 `extensions/subagent/config.json` 中启用 `"toolActivation": "eager"`，消除旧版首轮需先调用 `subagents_enable` 的二段延迟；非科研与科研会话均可在首轮直接使用 `subagent`。
2. **动态路由与三档模型配额顺位**
   - `extensions/research-loop/src/delegation-policy.mjs` 根据当前工具集自动切换引导：非 `res-workflow` 会话优先使用 7 个通用工具型角色与按需调用 `agy-advisor`；加入 `res-workflow` 后开放完整科研角色矩阵与 `research_dispatch` 图谱。
   - `extensions/research-loop/model-policy.json` 明确 **工人档（`worker`）→ 指挥档（`commander`）→ 智力档（`intelligence`）** 三档优先队列与降级顺位，并移除已下线的 `cliproxy/deepseek-pro[1m]` 与 `gpt-6-astra*`。
3. **新增确认式 `agy-advisor` 外部咨询角色**
   - 定义文件：`agents/agy-advisor.md`（默认由 `cliproxy/gpt-6.2-astra(high)[1m]` 驱动）。
   - 执行「先只读发现 live 模型与 `--effort` → 经父会话 `ask_user` 请用户确认模型、档位与外发范围 → 在受控目录 `AGY_WORKDIR` 内调用 `agy-subagent`」三步闭环。
4. **`res-workflow`「先 Plan 后 Work」、1:N Plan 拓扑与前端进度 UI**
   - 主 Agent 下发任务、状态提示与后端接口统一围绕 `Plan` 驱动；支持 1 个 `Plan` 对应 N 个 `Multi-Agent` 任务及依赖 DAG。
   - Dashboard 提供主 Agent 级 **Plan 完成进度条** 与 **4 层同图内联拓扑（L0 主 Agent → L1 Plan → L2 Multi-Agent → L3 Subagent → L4 多次执行）**：点击 `Plan` 或 `Multi-Agent` 节点直接在原画布内展开/收起下一层，不跳转页面、不切换画布；点「详情与纠偏」再打开完整会话详情弹窗。
5. **同 `plan` Multi-Agent 横向兄弟通信（策略 A 三态）**
   - `research_dispatch action="status"` 返回本 `plan` 的有界 `peers` 花名册，含精确工作三态：`in_progress`（进行中）、`queued`（排队中）、`ended`（已结束）。
   - `research_communication` 支持同 `plan` 队友点对点消息、延迟备忘（`queued` 不唤醒、不插队）、`to="peers"` 广播（仅 `progress` / `decision`）、单对队友 8 条（4 轮）上限以及 `peerSettled` 优雅退休保护。

---

## 三、文档导航与关联源码索引

- **[Subagents 详细使用指南](subagents.md)**
  - 常驻目录扩容与 `toolActivation: "eager"` 配置
  - 通用角色、科研专职角色、外部 CLI 角色清单与适用场景
  - 三档模型池配额顺位（`worker` / `commander` / `intelligence`）与调用模板
  - `agy-advisor` 模型发现、用户确认与 `agy-subagent` 执行流程
- **[Multi-Agents 详细使用指南](multi-agents.md)**
  - `res-workflow` 加入流程与「先 Plan 后 Work」生命周期
  - `research_dispatch` 首次分工确认、全量队列（≤ 64 任务）、并发与恢复操作
  - Dashboard 前端交互：Plan 完成进度条、L0–L4 同图内联拓扑、三态标识与详情弹窗
  - 同 `plan` 兄弟通信（策略 A 三态、广播、8 条防循环限制与 `peerSettled`）

### 关键配置与实现文件索引

| 类别 | 路径 | 职责 |
| --- | --- | --- |
| 三档模型策略 | [`extensions/research-loop/model-policy.json`](../extensions/research-loop/model-policy.json) | `intelligence` / `commander` / `worker` 模型顺序与降级链 |
| 动态委派路由 | [`extensions/research-loop/src/delegation-policy.mjs`](../extensions/research-loop/src/delegation-policy.mjs) | 按激活工具区分独立/工作台引导、默认模型模板与超限读取提醒 |
| 子代理默认配置 | [`config/settings.example.json`](../config/settings.example.json) | 7 个通用常驻角色（`advertise: true`）与 6 个外部 CLI（`thinking: false`）覆写 |
| 专项角色定义 | [`agents/`](../agents) | 11 个仓库内置专项/科研/外部咨询角色（含 `agy-advisor.md`） |
| Subagent 补丁与清单 | [`config/subagents-v020.json`](../config/subagents-v020.json) / [`patches/subagents/`](../patches/subagents) | `pi-subagents@0.79.2` 的调度与 `25` 角色 / `20 KiB` 目录上限补丁 |
| 宿主调度与兄弟通信 | [`extensions/research-host/services/`](../extensions/research-host/services) | `research-dispatch-service.mjs`、`research-communication-service.mjs`、`research-session-service.mjs` 等 |
| 工具客户端实现 | [`extensions/research-loop/src/`](../extensions/research-loop/src) | `workbench-dispatch-tool.mjs`、`workbench-communication-tool.mjs`、`workbench-context.mjs` |
| Dashboard 前端视图 | [`patches/dashboard-v0.20/overlay/packages/client/src/components/research/`](../patches/dashboard-v0.20/overlay/packages/client/src/components/research) | `research-plan-topology.ts`、`ResearchPlanProgressBar.tsx`、`ResearchAgentCanvas.tsx` 等 |
