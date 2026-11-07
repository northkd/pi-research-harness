# 研究预算由用户把控

2026-11-07 更新。项目不再自行设置科研尝试次数、模型请求次数、恢复重试次数、Goal 轮数或费用的总上限。实际响应、token、尝试、在途与结果未知请求继续记录，用户可以观察用量并主动暂停或取消。

## 生效范围

| 执行入口 | 新行为 | 历史数据处理 |
| --- | --- | --- |
| 常规 `research_loop` | 无预算配置前置，尝试次数不会触发额度停机 | 原有尝试、主张与证据记录保留 |
| 旧 `research-budget` 适配器 | `limits.attempts`、`limits.modelRequests` 返回 `null`，`enforcement` 为 `false`；没有 policy 也可以登记请求 | 旧有限或零额度 policy、revision、scope、reservation、settlement 原样保留；有限值不再决定是否允许执行 |
| 完整历史接入 v2 | 不限制总调用次数、单节点尝试次数或恢复请求额度，计划可超过原 128 节点 | 旧 grant 中的有限字段仍可读取；计划规模用于说明工作量，不再作为额度。旧的预算耗尽任务可以沿用 checkpoint 继续 |
| 旧历史复核 v1 | 取消 128 次计划上限 | 材料选择、计划一致性和逐节点结果继续核对 |
| 旧只读接入助手 | 取消 6 次总请求、4 次读工具阶段、32 次工具调用与累计读取量的预算门槛 | 分页读取、引用验证和用量累计保留 |
| Goal | 取消默认 20 轮停机、旧轮数额度和 Dashboard 的预算暂停；页面显示已用轮数与实际费用 | 旧 session 读取时得到 `maxTurns: null`，原记录字节不改写；Resume 保留已用轮数、目标和接受标准 |
| 空闲阶段识别 | 取消默认每日 8 次额度，忽略旧每日额度字段 | 每日调用数和审计继续累计；重启或 charter 更新不会重置历史文件 |

研究总览、资料接入和 Goal 不再提供研究预算上限编辑器。资料接入仍要求确认具体材料范围和分析模型；这项确认不附带次数额度。用量面板显示观测值，结果未知不等于未计费。

兼容接口中的 `budget`、`grant.maxRequests` 等旧字段名暂时保留，避免破坏存量任务、请求身份和审计。有效额度以 `effectiveMaxRequests: null` / `policy: "unlimited"` 或 native 的空 limits 为准，旧有限值不会重新打开预算拦截。

## 继续保留的执行约束

此策略保留已有的材料、模型、项目与研究约定绑定，也保留人工暂停/取消、访问权限、任务 lease 和现有授权有效期。单次请求超时、模型上下文与输出容量、单页及结构化记录大小、内存准入仍有原有约束。这些约束不被表示成可消耗的科研额度。

空闲检查继续依赖内容变化、空闲阈值、冷却、退避与单请求互斥。Goal 遇到真实阻塞仍暂停，连续不可解析的 judge 输出和进程崩溃仍有故障保护。取消预算上限不会把失败响应记作科学验收，也不会自动扩大原有资料发送范围。

## 原生 Goal 补丁

固定包是 `@ricoyudog/pi-goal-hermes@0.1.0`。新补丁同时保留之前的 Resume 进度、阻塞与完成分离、过期 judge 防护，并将 judge 调用接到 Pi 1.3 的 `ctx.modelRegistry.streamSimple`。该版本 SDK 已不再从 `pi-ai` 根入口导出旧的全局 `streamSimple`。

安装器认证完整的九文件 SHA-256 清单，支持原始 npm 包和上次发布的 Resume 补丁两种来源；混合版本或本地改动会拒绝覆盖。重复执行和 `--check-only` 不改写文件。

```bash
# 路径替换为实际安装 Goal 的隔离 agent 目录。
node scripts/apply-goal-hermes-patch.mjs /absolute/agent-dir --dry-run
node scripts/apply-goal-hermes-patch.mjs /absolute/agent-dir --apply
node scripts/apply-goal-hermes-patch.mjs /absolute/agent-dir --check-only
```

Goal 是可选能力，未安装该包的环境不需要执行这组命令。不能只去掉 Dashboard 预算输入框而继续运行旧的原生 Goal：原包自身仍有 20 轮判断。

## 已有环境升级

更新 Harness 研究扩展，并用当前覆盖层重新准备、构建 Dashboard。先确认运行中的任务状态，在合适的维护时点加载新代码；仓库更新和网页刷新都不会替换已经加载到内存中的扩展。使用 Goal 的环境另外应用上述原生包补丁。不要为消除旧额度删除 policy、grant、研究约定、用量账本或 checkpoint，也不要重新创建同一科研任务。

`research-theory` 技能加载属于另一项原生补丁，已有 agent 还需按[技能按需加载说明](subagent-skill-loading.md)运行 `apply-subagents-v020.mjs` 和定向设置迁移。本次预算更新涉及前端，不能沿用“仅技能修复无需重建前端”来省略 Dashboard 构建。

## 验证方法

全部验证使用隔离目录和合成响应，没有发送真实科研材料或产生付费模型请求。

[结构化验证记录](research-budget-validation.json)记录完整结果：仓库测试 414 项与主线监督 64 项全部通过；接入后端 25 项、接入界面 44 项、Goal 插件 188 项全部通过。完整 TypeScript 检查、675 文件覆盖层校验与构建通过。前端构建使用 4 GiB Node 堆；默认约 2 GiB 堆的首次构建在输出 bundle 后耗尽内存，增加构建进程堆后同一源码成功。

- 原生账本：无 policy、旧零额度和旧有限额度均可执行，真实物理重试分别计数，历史 policy 字节保持不变；绑定、冲突和研究约定校验仍有效。
- 接入后端：跨过旧调用/节点额度后仍记录 intent、receipt 和 checkpoint；冷恢复、取消与未知结果继续遵循同一记录协议。
- 空闲阶段：同日 11 次变化材料检查跨过旧额度，重启后继续；无变化时仍去重。
- Goal：实际安装补丁后的包通过 Pi 1.3 provider 入口记录合成 judge 用量；连续 41 轮继续工作，恢复已用 250 轮的旧任务不清零；手动暂停、清除、完成、阻塞和过期 judge 检查保留。
- 安装：原始 Goal 包和上次补丁均完整升级，重复安装及校验无写入；Dashboard 覆盖层按固定上游 blob 与内容哈希发布。

关键复现命令：

```bash
node --test tests/research-budget-accounting.test.mjs \
  tests/research-without-budgets.test.mjs \
  tests/idle-stage-review.test.mjs tests/goal-hermes-patch.test.mjs

node scripts/test-goal-no-budget-sdk.mjs \
  /absolute/pi-coding-agent-package /absolute/patched-pi-goal-hermes-package

npm test
npm run check:syntax
npm run check:release
```

本次源码和离线回归不等于生产进程已经更新，也不证明真实模型延迟或账单金额。
