# 0.20 开发与部署

`main` 保存 0.20 开发源码；`0.10` 保留 0.20 发布前的 GitHub `main`，没有改写其提交。需要注意：`0.10` 是旧仓库快照的分支名，旧快照的包元数据仍是 0.1.0，并且其 Dashboard 配置固定为 0.8.0；这不等于服务器此前运行的 Dashboard 0.10.0。

0.20 使用 Dashboard 上游 v0.10.0 的固定提交、Pi 1.3.0、`pi-subagents` 0.79.2，以及仓库内的源码覆盖层与科研扩展。覆盖层中的每个文件都带有基线 Git blob 和发布 SHA-256 校验；安装不会复制 `node_modules`、私人研究记录、模型凭据或运行日志。

## 新设备首次安装

准备 Git、Python 3、Node.js 22.19 或更新版、npm 和 pnpm 11.15.1。以下命令创建新的隔离 agent；如果目标已有配置，安装器会拒绝覆盖。

```bash
git clone https://github.com/northkd/pi-research-harness.git
cd pi-research-harness
npm test
npm run check:release
bash scripts/install.sh --with-dashboard --dry-run
bash scripts/install.sh --with-dashboard
bash scripts/prepare-dashboard.sh
export PATH="$PWD/bin:$PATH"
pi-research-dashboard
```

Dashboard 默认只监听 `127.0.0.1:8000`。安装和构建不会自动启动或重启服务。当前安装器为全新配置设计，现有 agent 需要手动合并扩展路径，不能直接覆盖。

## 本机 CLIProxyAPI

启动自己的 CLIProxyAPI 后，在启动 Dashboard 的同一终端环境中设置 `PI_RESEARCH_PROXY_API_KEY`。不要将密钥写入 Git 或发送给他人。下面的同步命令只访问本机 `127.0.0.1:8317` 的模型目录，保留其他 provider，并在 `models.json` 中保存环境变量引用，不保存密钥；`--set-default` 会显式调整该 agent 的默认模型。

```bash
# PI_RESEARCH_PROXY_API_KEY 已由本人在当前 shell 安全设置
export PI_RESEARCH_AGENT_DIR="${PI_RESEARCH_AGENT_DIR:-$HOME/.local/share/pi-research-harness/agent}"
node scripts/sync-cliproxy.mjs "$PI_RESEARCH_AGENT_DIR" --set-default
pi-research-dashboard
```

如未设置 `PI_RESEARCH_AGENT_DIR`，参数应改为实际 agent 目录，默认是 `~/.local/share/pi-research-harness/agent` 的绝对路径。不同机器分别配置各自的代理和凭据。本次验证过模型目录读取，没有进行真实模型推理。

## 工作台与同步服务

`research-loop` 扩展位于 `extensions/research-loop/`，Dashboard 源码位于安装后 `.runtime/dashboard-source/`，定制覆盖层位于 `patches/dashboard-v0.20/overlay/`。Dashboard 启动后，另外运行：

```bash
pi-research-workbench-sync --dry-run
pi-research-workbench-sync
```

该服务只监听 `127.0.0.1:18767`，读取同一用户的 Dashboard 本地令牌。Dashboard 和同步服务须使用相同的 `HOME`、`PI_RESEARCH_AGENT_DIR` 和 `PI_DASHBOARD_PORT`。同步服务不会自动启动模型或任务；若未启动，科研文件仍可显示，Multi-Agent/Subagent 的实时观测不可用。真实项目仍需在界面按实际授权流程接入，项目会话与科研数据不会从 GitHub 自动恢复。

需要体验本地模拟时，可在一个不存在、目录名含 `demo` 或 `演示` 的目录生成明确标记的虚构项目：

```bash
node scripts/create-demo-project.mjs /absolute/path/to/new-demo-project
```

脚本会输出本地模拟入口。打开后可查看 4 个虚构 Multi-Agent 和 8 个虚构 Subagent，并播放或单步；演示标签页拦截实际模型请求和写入。退出演示后回到正常 Dashboard，按钮仍是实际操作。手动重新执行前端构建后，需运行 `node scripts/install-demo-entry.mjs "$PI_RESEARCH_DASHBOARD_SOURCE/packages/client/dist"` 恢复演示入口。

## 本机开发更新覆盖层

需要改 Dashboard 定制时，编辑 `patches/dashboard-v0.20/overlay/` 中相应文件，再用已准备的上游检出重新生成校验清单：

```bash
node scripts/update-dashboard-manifest.mjs "$PWD/.runtime/dashboard-source"
export PI_RESEARCH_DASHBOARD_SOURCE="$PWD/.runtime/dashboard-next"
bash scripts/prepare-dashboard.sh
bash scripts/test-dashboard-v020.sh
npm test
```

新构建目录必须不存在；校验器会拒绝覆盖已有修改。新增的源码文件也会纳入清单，若它们在上游已存在则记录上游原始 blob。验证后提交本机代码并推送到 GitHub，再按服务器维护流程更新。

## 服务器更新

服务器上现有运行目录与 Git 检出是两套文件，**仅执行 `git pull` 不会更新正在运行的 Dashboard**。先确认服务器检出没有未保存更改，再拉取 `main`。构建时可使用新的目录并行准备，旧目录不会被覆盖：

```bash
git status --short
git pull --ff-only origin main
export PI_RESEARCH_DASHBOARD_SOURCE="$PWD/.runtime/dashboard-v020"
bash scripts/prepare-dashboard.sh
bash scripts/test-dashboard-v020.sh
```

服务切换前还需按服务器实际配置更新服务入口、agent 的 Dashboard bridge 路径、研究扩展及同步服务，并在维护窗口重启后检查健康状态和回滚路径。0.20 不会自动修改现有 systemd、Caddy、账号或科研数据。本次只发布仓库，未在服务器执行更新或重启。

## 已知边界

- 在 macOS 全新构建验证中，上游可选的 `ffmpeg-static` 视频组件下载超时；Dashboard 本身构建成功，该视频能力需另行安装验证。
- Science 的 host/worker 源码部分保留，但原查看服务与私人项目、机器路径及其他本机文件绑定，未作为通用服务发布；本机和服务器的 Science 端到端联通尚未验证。
- macOS 可以构建并展示 Dashboard。部分并行任务和主线监督的资源准入仍依赖 Linux `/proc/meminfo`，在 macOS 上会保持拒绝状态；不能把页面能打开等同所有科研流程均可执行。
- 当前来源中的少量开发源码与服务器正在运行的文件不同；0.20 是经过移除私人硬编码和凭据修正的开发基线，不保证与服务器运行目录逐字节一致。
- 使用公开仓库时，密钥、个人会话、科研项目、数据及模型账号应始终保留在仓库之外。
