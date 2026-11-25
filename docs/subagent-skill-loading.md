# 子代理技能按需加载

日期：2026-11-07。适用分支：`feat/autonomous-collaboration-20261106`。
运行版本：Pi `1.3.0`、`pi-subagents 0.79.2`，以及本仓库的原生补丁。

## 问题与已确认路径

`research-theory` 只承担本次数学或物理推导，不需要每次接收主会话的全局技能目录。
这里的目录指技能名称、description 和路径；原生所选技能本来就是在需要时通过 `read` 读取正文。
本修复不将“100 个目录条目”描述为“100 份完整 SKILL.md 正文”。

核对固定版本后发现，`inheritSkills` 的原生默认值已经是 `false`，普通 fresh 子代理本身不会继承全局目录。
实际 SDK 复现了另一条路径：fork 为复用父会话的提示词缓存，将父系统消息重新投影到 provider 请求中，绕过了子角色“不继承技能”的意图。
使用 50 个全局技能、25 个项目技能、25 个扩展发现技能构造父会话后，前台和后台 fork 都在首次请求携带 100 个目录条目；普通 fresh 为 0。
仅在角色模板补写 `inheritSkills: false` 无法解决这一 fork 路径。

用户的既有 settings 或 provider overrides 也可以重新开启继承，或者配置过大的默认技能列表，因此已有安装需要定向迁移生效设置。
以上是代码与隔离复现结果，不表示已读取用户生产环境配置或故障日志。

## 当前行为

`research-theory` 的发布配置使用三个原生字段：

```json
{
  "inheritSkills": false,
  "skills": [],
  "defaultContext": "fresh"
}
```

- **默认首轮**：角色要求与本次任务，不附加全局目录，不预选技能。
- **明确需要某项方法**：派发者使用原生 `skill` 参数指定名称或名称数组，通常只需 1–2 个。所选技能先提供元数据，正文仍按需读取。
- **`skill: false`**：取消本次的配置技能列表；它和 `inheritSkills` 是不同控制项，不能把它单独当成关闭全局继承。
- **显式 fork**：仍保留父对话历史与工具声明。`inheritSkills: false` 时，provider 请求中的父系统消息副本移除结构化 `sections.skills`；父会话文件与原始消息对象不改写。
- **显式 `inheritSkills: true`**：保留原生完整继承行为。主会话与其他角色的全局技能发现继续可用。

fork 过滤只处理 Pi 1.3 的结构化技能目录字段，不通过正则截断任意系统提示文本。用户手写在自定义 prompt、普通对话或历史工具结果中的技能正文不属于该字段，不会被自动删除。
去掉父目录会改变 fork 的系统前缀，因此不能保证原先的完整前缀缓存命中。用于独立推导时仍优先 fresh。
本次不修改模型、thinking、超时、工具权限或科研任务内容。

## 已有安装升级

更新当前分支源码后，针对**实际启动 Pi 的 agent 目录**执行以下命令。
`--project-dir` 用于同时处理该科研项目已有的 `.pi/settings.json`；如果项目文件不存在，脚本只报告，不创建。

```bash
node scripts/apply-subagents-v020.mjs /absolute/path/to/agent
node scripts/apply-subagents-v020.mjs /absolute/path/to/agent --check-only

node scripts/configure-subagent-skills.mjs /absolute/path/to/agent --project-dir /absolute/path/to/project --dry-run
node scripts/configure-subagent-skills.mjs /absolute/path/to/agent --project-dir /absolute/path/to/project
node scripts/configure-subagent-skills.mjs /absolute/path/to/agent --project-dir /absolute/path/to/project --check-only
```

更新脚本只调整 `research-theory` 的 `inheritSkills`、默认 `skills` 和 `defaultContext`，也修正已有的同角色 provider overrides。
默认技能列表清空后，单次派发仍可显式选择技能。模型、thinking、tools、自定义角色正文、其他角色、主会话技能配置和 auth 文件保留。
写入前验证全部目标文件；原文件留有仅本人可读的精确备份，替换采用同目录原子写入。重复执行不重复改写。
`--check-only` 在仍需更新时返回非零退出码；`--dry-run` 不写文件。输出不会打印完整 settings 或凭据。

subagents 补丁安装器继续核对版本与全部受管文件的 SHA-256，可从完整上游、旧研究预算补丁、上一版模型保持补丁升级。
未知改动或部分补丁状态会明确失败，不静默覆盖。

在当前任务的安全停点重新启动实际运行的 Pi 进程，使已加载的原生 ESM 模块和设置重新生效；只刷新 Dashboard 页面不能替换原生模块缓存。
不需要为这次技能修复重建 Dashboard 前端。已进入对话历史的目录不会追溯删除；重新分发的 fresh 子任务使用新策略。

仓库的 `configure.mjs` 面向全新安装，拒绝覆盖已有目录。因此旧安装不能只更新仓库里的角色模板，也不能用重新安装覆盖私人配置。

## 可复现验证

常规离线测试包含结构化 fork 消息过滤、不可变性、配置迁移、备份、重复执行、损坏配置和写入失败回滚。
实际 SDK 验证使用固定版本与 synthetic provider，截获发给 provider 的最终消息，并通过真实 `read` 工具验证按需读取：

```bash
npm test
node scripts/test-subagent-skill-loading-sdk.mjs /absolute/path/to/pi-coding-agent /absolute/path/to/patched/pi-subagents
```

SDK 检查覆盖 fresh / fork、前台 / 后台、显式选择 1 / 2 项、取消配置技能、显式开启继承、主会话及其他角色不受影响。
它先创建真实父会话，再用 `SessionManager.forkFrom()` 创建子会话；不是仅检查模板或手工构造一段 prompt。
`--baseline` 可在旧补丁的固定版本上重现全量目录；正常模式要求 fork 已遵守关闭继承的策略。

本次实际运行结果见 [验证数据](subagent-skill-loading-validation.json)：

| 路径 | 修复前请求的技能条目 | 修复后请求的技能条目 |
|---|---:|---:|
| 前台 / 后台 fresh | 0 | 0 |
| 前台 / 后台 fork | 100 | 0 |
| fork，显式选 1 项 | 100 | 1 |
| fork，显式选 2 项 | 100 | 2 |
| 主会话与显式开启继承的其他角色 | 100 | 100 |

此处统计请求中的去重技能元数据；fork 的显式所选技能按原生行为放在子任务说明中。
同一份 100 技能合成输入下，默认 fork 的系统消息 JSON 序列化长度从 44,656 字符降至 7,902 字符，减少约 82.3%。字符数不是模型 token 数，也不是实际延迟。
完整离线套件 434 项通过、0 项失败、3 项可选 SDK / Dashboard 环境检查跳过；本次另行执行的技能加载 SDK 检查和 16 项模型保持 SDK 检查全部通过。
三个真实安装来源（完整上游、旧预算补丁、上一版模型保持补丁）的升级、SHA 校验和重复执行均通过。发布语法与边界检查通过。

测试中的模型标识可使用 `deepseek-v4-pro`，但响应来自本地 synthetic provider，外部网络请求计数为 0。
这些测试证明请求内容缩小和技能仍能按需使用，不等同于真实 DeepSeek 服务已完成推理，也不构成对所有思考超时原因的消除保证。

## 实现索引

| 文件 | 作用 |
|---|---|
| [research-theory.md](../agents/research-theory.md) | 角色的明确继承策略与按需使用说明 |
| [settings.example.json](../config/settings.example.json) | 全新安装的窄技能默认值 |
| [research-skill-context.mjs](../patches/subagents/support/research-skill-context.mjs) | provider 请求中的结构化 fork 技能过滤 |
| [subagents-v020.json](../config/subagents-v020.json) | 固定版本补丁与升级校验清单 |
| [configure-subagent-skills.mjs](../scripts/configure-subagent-skills.mjs) | 已有安装设置的定向迁移 |
| [test-subagent-skill-loading-sdk.mjs](../scripts/test-subagent-skill-loading-sdk.mjs) | 实际 SDK 首轮请求与按需 read 验证 |
