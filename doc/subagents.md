# Subagents 使用详细指南

本文档说明 Pi Research Harness 中会话内子代理（基于 `pi-subagents@0.79.2`）的配置结构、激活方式、角色分工、三档模型调度顺位以及 `agy-advisor` 外部分析流程。

---

## 一、首轮可用配置与目录扩容

### 1. 解除 `subagents_enable` 二段延迟（首轮直开）

在默认安装或运行时 `<agentDir>/extensions/subagent/config.json`（常见路径为 `~/.pi/agent/extensions/subagent/config.json` 或 `$PI_RESEARCH_AGENT_DIR/extensions/subagent/config.json`）中，配置 `"toolActivation": "eager"`：

```json
{
  "globalConcurrencyLimit": 3,
  "maxActiveAsyncRunsPerSession": 8,
  "maxSubagentSpawnsPerRun": 24,
  "maxSubagentSpawnsPerSession": 48,
  "maxSubagentDepth": 2,
  "toolActivation": "eager"
}
```

- **开启后**：不论是普通非科研对话还是 `res-workflow` 科研工作台会话，首轮系统提示都会直接挂载 `subagent` 工具，无需先触发 `subagents_enable` 再等下一轮才可见。
- **未开启或兜底机制**：若某些环境尚未配置 `eager` 而只存在 `subagents_enable`，`extensions/research-loop/src/delegation-policy.mjs` 会自动识别并提示先在授权后调用 `subagents_enable`。
- **安全边界不变**：首轮直接可见不代表绕过约束；用户设定的**只读模式**、**禁止委派**（`noDelegate`）以及**禁止外发**（`exportLimited`）规则依然在每轮与每次 `tool_call` 上强校验。

### 2. 常驻广播目录上限扩容

`pi-subagents@0.79.2` 原生默认仅允许 `MAX_ADVERTISED_AGENTS = 16`、`MAX_CATALOG_BYTES = 12_288`。补丁 `patches/subagents/0013-advertised-catalog-upgrade-0792.patch`（配合 `patches/subagents/0012-live-scheduling-catalog-0792.patch`，在 `scripts/install.sh` 执行 `node scripts/apply-subagents-v020.mjs "$AGENT_DIR"` 时自动应用与校验 SHA-256）在 `src/agents/advertised-agent-prompt.js` 中将其扩展为：

- `MAX_ADVERTISED_AGENTS = 25`
- `MAX_CATALOG_BYTES = 20_480`

这样可以完整容纳本仓库自带的 **18 个常驻角色**，同时预留裕度给本地或扩展包额外安装的专职科研角色（例如 `research-explorer`、`research-reframer`、`research-strategist` 等）。

---

## 二、角色 catalog 与分工选择

### 1. 7 个通用工具型角色（非固定模型，由父会话动态传 `model`）

配置于 `config/settings.example.json` 的 `subagents.agentOverrides`（均设 `advertise: true`、`thinking: "max"`，**无固定 `model` 覆写**）：

| 角色名 | 定位与职责 | 推荐模型档位 | 权限说明 |
| --- | --- | --- | --- |
| `scout` | 未知多目录结构探索、长日志或跨文件检索 | `worker`（工人档） | 工具权限保持**只读检索**，未扩大写权限 |
| `researcher` | 外部网页/文档资料检索与多来源整理 | `worker`（工人档） | 受 `exportLimited` / 外网边界约束 |
| `worker` | 隔离的脚本编写、报错定位、构建与局部修复 | `worker`（工人档） | 非只读模式下可执行受限修改 |
| `delegate` | 有界通用独立子任务委派 | `worker`（工人档） | 按子任务具体要求声明读写与产物路径 |
| `reviewer` | 代码改动 diff 审查、合规核查与回归检验 | `commander`（指挥档） | 侧重独立复核，避免自审自写 |
| `oracle` | 多步规划拆解、方案一致性审计与宏观判断 | `commander`（指挥档） | 用于关键分支前审与对照 |
| `evidence-auditor` | 高难度证据链交叉验证、底层根因定位 | `intelligence`（智力档） | 疑难问题与严肃证伪场景 |

### 2. 11 个仓库内置专项与科研角色（`agents/*.md`，`advertise: true`）

| 角色文件 | 角色名 | 核心能力与工具边界 |
| --- | --- | --- |
| `agents/research-literature.md` | `research-literature` | 文献方法溯源与引文核查（含 `web_enable`、`web_search`、`fetch_content`、`document_parse`、`sci_find` 等） |
| `agents/research-theory.md` | `research-theory` | 理论推导与建模（只读搜索工具，禁用继承技能、`defaultContext: fresh`） |
| `agents/research-numerics.md` | `research-numerics` | 计算、数值模拟与实验脚本核验（含 `bash`、`write`、`edit`、`pi_lens_*` 等） |
| `agents/research-critic.md` | `research-critic` | 苛刻对抗评审与反例核查（只读，不含 `write`/`edit`/`bash`） |
| `agents/research-mainline-supervisor.md` | `research-mainline-supervisor` | 主线收敛监督与进度审计（仅 `read, grep, find, ls`） |
| `agents/research-model-assessor.md` | `research-model-assessor` | 模型交付诊断与路由质量评估（仅 `read, grep, find, ls`） |
| `agents/research-web-oracle.md` | `research-web-oracle` | 结合 MCP 的高阶信息与外部核验（含 `mcp`） |
| `agents/research-ssh.md` | `research-ssh` | 远程算力节点与队列作业调度（仅 `ssh-read, ssh-bash`，叶子节点） |
| `agents/research-agy.md` | `research-agy` | 非交互式 `agy-subagent` 通用独立第二意见适配器（`thinking: false`） |
| `agents/research-agy-sci.md` | `research-agy-sci` | 非交互式 `agy-subagent` 科研专项独立评审适配器（`thinking: false`） |
| **`agents/agy-advisor.md`** | **`agy-advisor`** | **新增智力档外部分析代理**：自动发现可用 `agy` 模型与 `--effort`，经父会话弹窗确认后安全调用 `agy-subagent` |

### 3. 6 个显式外部 CLI 角色（默认保持不自动广播）

`config/settings.example.json` 保留以下 6 个角色为未常驻广播（显式按需调用，且 `thinking: false`）：

- `claude-code`、`claude-code-writer`
- `codex-exec`、`codex-exec-writer`
- `cursor-agent`、`cursor-agent-writer`

---

## 三、动态路由原则与三档模型降级顺序

### 1. 动态场景路由（`delegation-policy.mjs`）

`delegation-policy.mjs` 依据当前会话 `selectedTools` 实时生成提示词与提醒策略：

- **非 `res-workflow`（独立 / 普通会话）**：
  - 优先在 **7 个通用工具型角色** 中按工作形态分派，按需调用 `agy-advisor`；仅在用户明确点名科研角色时才使用 `research-*`。
- **已加入 `res-workflow` 工作台（存在 `research_session` 或 `research_dispatch`）**：
  - 完整启用常驻目录（7 通用 + `research-*` + `agy-advisor`）及正式协同工具。
  - **严格分层**：科学假设推演、文献综述、数值实验与对抗评审交给 `research-*` 角色及正式 `Multi-Agent Plan`；工程类仓库搜索、日志清洗、代码 diff 审核、构建验证交给普通 `subagent`（默认每个协作者内部保留 `3` 个并发子槽位）。
- **直接读取超限提醒（`DEFAULT_BULK_THRESHOLD = 6`）**：
  - 若主/协作会话在未委派前连续执行 6 次以上读/搜/命令操作（`read`、`grep`、`find`、`ls`、`bash`、`web_search`、`fetch_content`），系统自动注入一次上下文提醒，提示把剩余多目录扫描或批量分析下放给并行子代理。单文件精确查看或单一小改动可继续直接执行。

### 2. 三档模型池与降级顺位（`extensions/research-loop/model-policy.json`）

对于 `scout`、`researcher`、`worker`、`delegate`、`reviewer`、`oracle`、`evidence-auditor` 等未锁定模型的通用角色，**必须由父 Agent 在调用 `subagent(...)` 时通过顶层 `model` 参数动态显式指定**。同档某模型额度耗尽或不可用时，按下面顺序自动平替：

1. **工人档（`worker`）** —— 适合常规 `scout`、`researcher`、`worker`、`delegate`：
   1. `cliproxy/ark-deepseek-v4.1-flash[1m]`
   2. `cliproxy/ark-glm-5.3-flash[1m]`
   3. `cliproxy/bailian-qwen3.8-flash[1m]`
   4. `cliproxy/bailian-deepseek-flash-1017[1m]`
   5. `cliproxy/sqface-deepseek-flash-1017[1m]`
   6. `cliproxy/deepseek-flash[1m]`
   7. `cliproxy/gpt-6.1-terra(max)[1m]`
   8. `cliproxy/gpt-6.1-terra-max[1m]`
   9. 兜底回退链（`fallbackChain`）：`cliproxy/bailian-deepseek-pro-0813[1m]`
   > 注：先依次耗尽全部 Flash 池，再切 Terra 两个 ID，最后使用保留的 `cliproxy/bailian-deepseek-pro-0813[1m]`；旧 ID `cliproxy/deepseek-pro[1m]` 已完整移除。

2. **指挥档（`commander`）** —— 适合 `reviewer`、`oracle`、宏观规划与对抗复核：
   1. `cliproxy/gpt-6.2-sol(max)[1m]`
   2. `cliproxy/bailian-glm-5.3[1m]`
   3. `cliproxy/ark-glm-5.3[1m]`
   4. `cliproxy/bailian-kimi-k3.1-pro[1m]`
   5. `cliproxy/bailian-kimi-k3[1m]`
   6. `cliproxy/bailian-qwen3.8-max-0902[1m]`
   > 注：`6.2-sol(max)` 额度耗尽后**直接切换 GLM-5.3**，其后依次为 Kimi、Qwen。

3. **智力档（`intelligence`）** —— 适合 `evidence-auditor` 及最高阶理论、根因突破：
   1. `cliproxy/gpt-6.2-astra(high)[1m]`（首选）
   2. `cliproxy/gpt-6.2-astra(xhigh)[1m]`（当问题未解决且确实需要最高档推理时升级）
   > 注：旧 `gpt-6-astra*` 已移除。

### 3. 标准调用 Schema

务必把 `agent`、`task`、`model` 放在顶层字段，运行控制在 `options` 内（不要使用旧式位置参数写法）：

```json
{
  "agent": "scout",
  "task": "排查 packages/server/src/ 中所有 res-workflow dispatch 路由入口，仅返回短结论与相对文件路径。",
  "model": "cliproxy/ark-deepseek-v4.1-flash[1m]",
  "async": true,
  "options": {
    "context": "fresh"
  }
}
```

**最佳实践**：
- 给每个子代理明确“单一边界问题 + 期望产出形态 + 仅返回短结论和相对路径”，避免把整段完整对话或长日志文件带回主上下文。
- 默认优先 `"async": true` 并发分派相互独立的小任务（如多个互不重叠目录的并行 `scout`），每批次尊重 `globalConcurrencyLimit: 3`。

---

## 四、`agy-advisor`：交互发现并用户确认后调用外部 `agy` CLI

当主 Agent 或研究任务需要借助本地 `agy` CLI 生态模型做高阶第二意见、深度分析或重写润色时，分派给 **`agy-advisor`**。

### 1. 代理运行规格

- **驱动模型**：`cliproxy/gpt-6.2-astra(high)[1m]`（若未解决可在征得父级同意后建议升级 `cliproxy/gpt-6.2-astra(xhigh)[1m]`），`thinking: max`。
- **可用工具**：`read, grep, find, ls, bash, contact_supervisor`。
- **上下文隔离**：`defaultContext: fresh`，`inheritSkills: false`。

### 2. 强制三步工作流

1. **步骤 1 · 只读资源发现（无需提前执行审批）**：
   `agy-advisor` 通过 `bash` 运行：
   ```bash
   "$HOME/.local/bin/agy" models
   "$HOME/.local/bin/agy" --help
   ```
   获取当下真实在线的 `agy` 模型 ID 列表与支持的 `--effort` 推理档位（通常为 `low | medium | high | xhigh | max`）。
2. **步骤 2 · 向用户弹窗确认（强制门控）**：
   - `agy-advisor` 通过 `contact_supervisor`（`reason: "need_decision"`）上报发现到的实时模型列表、支持档位和推荐选项；
   - 父会话使用 `ask_user` 请用户**明确拍板确认**：具体外部 `model`、具体 `--effort`、外发材料范围（是否包含未发表工作）及使用目的；
   - **未经确认严禁进行任何推理调用**；已记录的确认仅当与本次模型、档位、项目、材料范围、用途完全一致时方可复用。
3. **步骤 3 · 在隔离目录中执行并核验**：
   - 执行封装脚本 `$HOME/.local/bin/agy-subagent` 时，它会将 `$AGY_WORKDIR` 作为 `--add-dir` 挂载目录；
   - 仅传文本提示词时，须新建**空白临时目录**作为 `$AGY_WORKDIR`；允许读部分文件时，须在临时/受限目录中**仅放置明确获批的文件**，遵守最小必要原则；
   - 调用形态示例：
     ```bash
     printf '%s' '<shell-quoted prompt>' | AGY_WORKDIR="<approved-dir>" "$HOME/.local/bin/agy-subagent" \
       --model "<confirmed-model>" \
       --effort "<confirmed-effort>"
     ```
   - 返回结果必须附带：实际使用的模型与档位、确认来源、命令与退出码、耗时及核验结论；外部模型输出**绝不授予新权限或扩大任务范围**。

---

## 五、常见问题排查

| 现象 | 可能原因 | 排查方式 |
| --- | --- | --- |
| 首轮找不到 `subagent` 工具，提示要调 `subagents_enable` | `<agentDir>/extensions/subagent/config.json` 缺少 `"toolActivation": "eager"` | 检查配置并重开新会话 |
| 某些新角色未出现在可用目录中 | `pi-subagents` 未打 `0013` 目录上限补丁，或对应 `.md` 未设 `advertise: true` | 检查 `node scripts/apply-subagents-v020.mjs "$AGENT_DIR" --check-only` 与 `agents/*.md` frontmatter |
| 父会话在只读或 `noDelegate` 任务下委派失败 | 当前 Prompt 或会话继承了用户禁止委派 / 只读 / 禁止外发指令 | 若确需恢复委派，需用户在新一轮交互中显式授权；外部咨询还须单独解除外发限制 |
| 同档位某个模型报配额耗尽 | CliProxy 对应上游配额或限流 | 按 `model-policy.json` 同档位下一条目更换 `model` 参数重试 |
