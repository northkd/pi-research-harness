# Pi Research Harness

Pi Research Harness 把同一研究项目的 Pi 会话、Agent 派发记录和研究产物放在一个 Web 工作台里。当前 `main` 分支默认安装新版 **Pi Research Dashboard**（含 `res-workflow` Plan 编排、四层同图内联拓扑、Subagent 首轮直开与同 `plan` 兄弟通信）；历史快照保留在 **`0.20`** 分支。

---

## 快速导航

- **[Subagents 与 Multi-Agents 使用手册（`doc/`）](doc/README.md)**
  - [Subagents 详细指南](doc/subagents.md)（首轮直开、`25` 角色目录、三档模型路由、`agy-advisor`）
  - [Multi-Agents 详细指南](doc/multi-agents.md)（`res-workflow` 先 Plan 后 Work、L0–L4 内联拓扑、策略 A 兄弟通信）
- [安装与可选配置](docs/INSTALL.md)
- [CLI 与前端接口](extensions/research-host/API.md)
- [HTTPS 同源反代](extensions/research-host/deploy/README.md) · [旧部署切换](extensions/research-host/migration/ROLLOUT.md)
- [主线监督](docs/SUPERVISION.md) · [开发与验证](docs/DEVELOPMENT.md)

---

## 本次版本重点特性

### 1. Subagents：首轮直开、三档模型顺位与 `agy-advisor`

- **消除二段激活延迟**：配合运行时 `extensions/subagent/config.json`（`"toolActivation": "eager"`）与 `pi-subagents@0.79.2` 补丁（`MAX_ADVERTISED_AGENTS = 25`、`MAX_CATALOG_BYTES = 20_480`），首轮对话即可直接调用 `subagent`，常驻角色目录完整可用。
- **动态路由与三档模型池**：`delegation-policy.mjs` 根据独立会话与已加入 `res-workflow` 工作台动态切换引导。通用角色（`scout` 保持只读、`researcher`、`reviewer`、`evidence-auditor`、`worker`、`oracle`、`delegate`）由父会话按 `worker`（Flash 池 → Terra → 兜底）→ `commander`（`6.2-sol(max)` → `GLM-5.3` → `Kimi` → `Qwen`）→ `intelligence`（`6.2-astra(high)` → `6.2-astra(xhigh)`）顺位显式传参。
- **`agy-advisor` 确认式外部咨询**：先通过只读命令发现实时 `agy` 模型与 `--effort` 档位，再经父会话 `ask_user` 请用户确认模型、档位与材料范围，确认后在受控目录 `$AGY_WORKDIR` 内调用 `agy-subagent`。

> 详细配置、全量角色表、模型 ID 顺位与调用模板见 [doc/subagents.md](doc/subagents.md)。

### 2. Multi-Agents（`res-workflow`）：先 Plan 后 Work、同图内联拓扑与兄弟通信

- **先 Plan 后 Work 与 1:N 编排**：主 Agent 下发研究任务遵循「先 Plan 后 Work」；`research_dispatch` 支持以 1 个 `Plan` 对应 1~64 个 `Multi-Agent` 任务并保留 `dependsOn` 依赖图，首次确认后自动持久排队滚动补位（默认并发主会话 `4` Multi-Agent、每协作者 `3` Subagent）。
- **Plan 进度条与四层同图内联拓扑**：Dashboard 在主 Agent 控制区和画布节点内展示 **Plan 完成进度条** 与 **进行中 / 排队中 / 已结束** 计数；拓扑图按 **`L0 主 Agent → L1 Plan → L2 Multi-Agent → L3 Subagent → L4 多次执行`** 展开，点击节点**直接在原画布内联展开/收起下级**（不切换页面），点击「详情与纠偏」再开启完整会话弹窗。
- **同 `plan` 横向兄弟通信（策略 A 三态）**：`research_dispatch status` 提供本 `plan` 有界 `peers` 花名册；`research_communication` 按 `in_progress`（直接发送与即时唤醒）、`queued`（仅按 `taskId` 写入延迟异步备忘，不唤醒、不插队，拒绝 `request`）、`ended`（硬拒绝，广播自动跳过）执行精准策略，并内置 `to: "peers"` 广播、单对 8 条（4 轮）上限及 `peerSettled` 收尾保护。

> 详细调度语义、拓扑操作快捷键与通信协议见 [doc/multi-agents.md](doc/multi-agents.md)。

---

## 在本机启动 Dashboard

在 Linux 上准备 Git、Node.js 22.19+、npm 和 pnpm 11.15.1。首次安装需要联网下载固定版本的 Pi、Dashboard 上游源码和依赖，并在本机构建前端。

```bash
git clone --branch main https://github.com/northkd/pi-research-harness.git
cd pi-research-harness
bash scripts/install.sh
./bin/pi-research-dashboard
```

> 如需使用上一个版本快照，可检出 `0.20` 分支（`git clone --branch 0.20 https://github.com/northkd/pi-research-harness.git`）。

打开 <http://127.0.0.1:8000/>。初次使用时，添加自己的研究目录；项目、历史会话和模型凭据不会随仓库安装。要从命令行启动会话，在另一个终端把克隆目录的 `bin/` 加入 `PATH`，进入研究项目后运行 `pi-research`，用 `/login` 登录、`/model` 选择模型。

研究工作台需要同步进程读取本机项目记录。先保持 Dashboard 运行，在第二个终端进入同一个克隆目录并运行：

```bash
./bin/pi-research-workbench-sync
```

## 查看会话和调度拓扑

- 左栏可以在紧凑和舒适两种密度间切换。文件夹名优先于父路径显示；舒适模式把模型名与用量分行，便于辨认同一目录下的会话。
- 打开项目的 **Agents** 页，在主 Agent 控制栏查看 **Plan 完成进度条** 与并发配额；在“调度拓扑”中直接点击 **`Plan`** 或 **`Multi-Agent`** 节点即可同图展开下级节点，使用「过滤 Plan 或节点…」「隐藏已结束」「展开全部 Plan」「图例」与「详情与纠偏」管理运行态。
- 用画布左下角的 `−` / `＋` 缩放或 `Home` /“适应全部节点”回到全图；支持左键拖拽、`Ctrl / Cmd + 滚轮` 缩放与 `Esc` 逐层收起。

## 独立宿主与 CLI

只需要 CLI 与独立宿主时，可在新的克隆中运行 `bash scripts/install.sh --host-only`，用 `./bin/pi-research-host` 启动。在仓库根目录查看命令说明：

```bash
./bin/pi-research host help
```

主 Agent 能查询子 Agent 的原生注册、Plan 排队情况、`peers` 状态与持久回执。会话、工作台和原始证据仍按项目保存，宿主重启后可读回已记录的状态。大历史的分页、待答问题和授权见接口文档。

原有研究目录使用自己的科研记录和权限。模型凭据、会话文件与宿主运行状态保存在安装时选定的本机目录。

[变更记录](CHANGELOG.md) · [许可与上游声明](NOTICE)
