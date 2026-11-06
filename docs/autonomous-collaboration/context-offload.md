# 把完整目标交给执行协调者

> 上下文减负历史记录。当前权限入口改为“默认权限 / 完全访问”，常规研究不再要求 task-grant 或预算前置，见[工作流控制说明](../workflow-controls/implementation.md)。下文保留原分发设计、字节测量及当时验证数据；上下文大小限制继续适用。

本轮补充处理主 agent 的上下文负担：此前即使工作交给了子会话，主 agent 仍要先读取材料、拆好全部任务，再接收包含任务说明、依赖和历史回执的完整 snapshot。现在可以直接提交目标，由独立的执行协调者负责详细分解和跟进，主 agent 接收汇总结果及证据引用。

## 分工与调用

`research_dispatch action="delegate"` 创建一个可追踪的 `research-coordinator` 子会话；协调者再通过 `plan` 派发 worker，收集结果、安排核验，最后向主 agent 提交一份聚合回执。协调者和 worker 都是独立 Pi 会话，保留真实父子来源，初始任务不复制父会话的整段对话。

| 角色 | 主要责任 |
|---|---|
| 主 agent | 明确目标、约束和验收条件，处理需要关注的决策，呈现最终结论 |
| 执行协调者 | 理解材料、拆分任务、调度专家、跟进阻塞、组织核验并汇总证据 |
| Worker | 完成限定工作，将实现细节和原始日志保留在自己的会话或证据文件中 |

**语义拆分仍由协调者模型完成。** 执行器负责已声明任务的依赖、并发、启动、持久化和结果上报契约，不能自行证明拆分合理或科研结论正确。[实现](../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs)

调用 `research_dispatch` 的示例：

```json
{
  "action": "delegate",
  "planId": "latency-evidence-v1",
  "stage": "2-experiment",
  "task": "依据 research/plan.md 完成已授权的推理延迟分析。保持验证集和计算预算不变；分开核对基线、实验配置和误差来源，安排独立复核。验收需包含中位数、p95、失败样本和证据路径。最终提交简洁结论与 report/latency.md 的引用；不要把原始长日志回传给主会话。"
}
```

重试使用相同 `planId` 和相同内容。`delegate` 内部只有一个协调者任务；已有明确拆分时仍可调用 `plan`，其任务数保持 2–12。真正不可拆分的工作使用 `atomic` 并登记具体理由。

主 agent 在需要分发的阶段可先做 3 次规划读取，之后应交给协调者；子任务运行期间，主 agent 的额外重复探索和接管实现会受到门控。这里的首次决策检查按**已核实的会话与研究约定范围**保存：该范围已有的历史计划或 `atomic` 记录也能满足检查。它不是对每一条新用户消息重新判断语义复杂度的分类器；新目标仍应主动建立对应的委派。[工具门控](../../extensions/research-loop/src/workbench-dispatch-tool.mjs)

只读要求通过持久化的 `readOnly: true` 向后代收窄，不能由子会话改成 `false` 来放宽。扩展根据已有用户限制和可信父会话元数据自动继承该标记；上例无需额外填写它。已知会话的身份或成员上下文暂时无法核实时，也不能借此跳过只读和分发门控。委派本身不增加工作区、模型、发布或计算授权。

## 上下文上限与按需读取

以下均按 **UTF-8 字节**计算，1 KiB = 1,024 字节。

| 内容 | 上限与范围 |
|---|---|
| 默认模型可见 dispatch 回执 | 每次最多 **8 KiB**；保留状态、失败计数、摘要和证据引用 |
| 显式详情回执 | 每页最多 **16 KiB**，包括分页元数据及 `recordHash` |
| 子会话初始任务提示 | **小于 16 KiB**；不内联完整父对话或依赖结果正文 |
| 每轮 Research Memory 段 | 最多 **8 KiB**，包含 charter 来源、hash、字段预览及截断提示；**固定工作流和 delegation guidance 在此预算之外** |

这些是特定注入段或工具回执的上限，不是整个会话、系统提示或全部 token 的上限。减负针对后续注入与返回，不清除已经进入主会话的历史上下文；完整任务与结果仍保留在会话记录和持久化账本中。重复状态可返回简短的 `unchanged` 确认，但保留失败或阻塞状态；需要恢复摘要时使用 `refresh: true`。[回执投影](../../extensions/research-loop/src/dispatch-context.mjs) · [初始提示](../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs)

Research Memory 优先保留目标、验收条件、约束和非目标。截断会明确标记，并指向 `.pi/research-loop/state.json#/charter/<field>`；遗漏内容不代表条件被取消，执行相应范围或宣称验收完成前须查阅完整字段。lead 的历史预览另限 1 KiB；子会话默认只获得历史来源引用，不自动灌入无关 accepted claims 或 ledger 正文。[记忆预算](../../extensions/research-loop/src/workbench-context.mjs)

协调者或 worker 如需读取自己的完整原始任务，可调用：

```json
{
  "action": "status",
  "view": "detail",
  "taskId": "self",
  "offset": 0
}
```

后续请求携带上一页返回的 `nextOffset` 和同一个 `recordHash`，直到 `complete: true`。如记录发生变化，继续页会明确拒绝，应从 `offset: 0`、不带旧 hash 重新读取，不能拼接不同版本。选定子任务使用 `planId` 与 `taskId`；直接依赖与自有任务同名时，可用当前 assignment 的父 `planId` 定位该依赖。查询只在已授权的 snapshot 范围内选择记录。

## 合成字节基准与验证边界

基准日期为 **2026-11-06**，原始运行产物为 `.runtime/qa-context-20261106/context-budget.json`，仓库保留[基准记录副本](evidence/context-budget.json)及[测量脚本](../../scripts/measure-dispatch-context.mjs)。方法是用相同的合成 snapshot，分别经过旧的 `JSON.stringify(snapshot, null, 2)` 路径和当前生产函数 `projectDispatchContext`，测量实际模型可见文本的 UTF-8 字节数。

| 合成输入 | 旧文本字节 | 新文本字节 | 本次文本减少 | 保留失败标记 |
|---|---:|---:|---:|---:|
| 6 项中等长度中文任务 | 21,484 | 6,579 | 69.38% | 1 |
| 24 项长中文任务 | 1,734,291 | 8,029 | 99.54% | 1 |

第一组每项任务说明 600 字符、摘要 400 字符、2 条各 48 字符的证据路径；第二组分别为 4,000、4,000 和 16 条各 1,002 字符的路径。上述数据是**合成输入的字节比较，不是真实模型 token、费用、任务质量或端到端总消耗测量**。分工会把详细工作移到独立会话，不能据此推断所有 agent 合计节省同样比例的 token。

本轮测试与部署记录见 [context-offload-validation.json](context-offload-validation.json)。本文不宣称已经完成真实模型或连续十几个小时的科研运行验证。
