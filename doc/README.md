# Subagents 与 Multi-Agents 使用手册

本手册帮你把 Pi Research Harness 的两套多代理协作能力用起来，并把日常配置、提问写法、界面操作和常见坑一次讲清楚。

---

## 一、先分清两种模式：我该用哪一个？

| 你当前的需求 | 推荐方式 | 怎么理解它 | 看哪篇文档 |
| --- | --- | --- | --- |
| “帮我查查整个仓库哪里用到这个接口”<br>“并行检查这几个报错日志”<br>“让审核助手看看我刚才改的代码”<br>“请外部 `agy` 模型给个第二意见” | **Subagents** | **同一次聊天里派出的“临时帮手”**：直接从主对话里起多个轻量子任务并发跑完，汇总结论给当前会话，不需要立项也不用专门看全局看板。 | [**Subagents 实用指南**](subagents.md) |
| “这是一个完整课题：我要一边调研文献、一边跑实验脚本、还要独立评审反例，完成后汇总成结论和报告” | **Multi-Agents**（`res-workflow`） | **项目级的“协作科研团队”**：围绕绑定好的研究目录，由主 Agent **先交 Plan（任务分工图）** 给你确认，再自动派生并管理多个**拥有独立对话窗口的正式协作者**，实时在网页看板追踪进度、排队、纠偏与相互传话。 | [**Multi-Agents 实用指南**](multi-agents.md) |

> **它们可以配合使用**：一个正式的 Multi-Agent 协作者在做实验或理论推导时，如果自己也需要临时查文件、审脚本，会自动再在自己内部派出 Subagent 小帮手。

---

## 二、上手前必查配置总表（普通用户照这张表配即可）

运行 `bash scripts/install.sh` 后，请按顺序核对以下几项（核心功能不依赖 `agy`，可按需选用）：

| 编号 | 你要配什么 | 文件/操作入口 | 不配会怎样 | 是否必需 |
| --- | --- | --- | --- | --- |
| 1 | **模型账号 / API 密钥** | 启动 `./bin/pi-research` 输入 `/login`；或复制 `$AGENT_DIR/models.example.json` 为 `models.json` 填 API；或用 `scripts/sync-cliproxy.mjs` | 模型无法发起对话，报未认证/无模型 | **必需** |
| 2 | **三档调度模型池** | 仓库根目录 `extensions/research-loop/model-policy.json` | 默认写的是 `cliproxy/...` 模型名；**不用 cliProxy 的用户如果不改成自己账号有的模型名，派 Subagent 时会报模型不可用** | **若不用 `cliproxy` 则必改** |
| 3 | **Subagent 首轮直开配置** | 新建 `$AGENT_DIR/extensions/subagent/config.json`，写入 `"toolActivation": "eager"` | 未创建时，部分环境首轮聊天无法直接看到 `subagent` 工具 | **强烈建议配置** |
| 4 | **Dashboard 与同步服务** | 终端 1 运行 `./bin/pi-research-dashboard`<br>终端 2 运行 `./bin/pi-research-workbench-sync` | 仅终端能聊；不跑终端 2 时，网页工作台收不到 Multi-Agent 实时进度和拓扑图 | 用网页工作台 / Multi-Agent 时**必需** |
| 5 | **`agy` 外部分析（按需）** | 提前安装并登录本机 `agy` CLI（`$HOME/.local/bin/agy` 或设 `AGY_BIN`） | 核心 Subagent/Multi-Agent 照常工作，但不能调用 `agy-advisor` / `research-agy` | 可选 |

（上表中的 `$AGENT_DIR` 默认为 `~/.local/share/pi-research-harness/agent`，若设置过 `PI_RESEARCH_AGENT_DIR` 则为其对应目录。）

---

## 三、下一步阅读

1. **[Subagents 使用指南（配置、角色表与日常提问写法）](subagents.md)**
2. **[Multi-Agents 使用指南（网页操作步骤、Plan 进度与拓扑图）](multi-agents.md)**
