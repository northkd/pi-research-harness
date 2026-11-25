# Pi Research Harness

Pi Research Harness 把同一研究项目的 Pi 会话、Agent 派发记录和研究产物放在一个 Web 工作台里。`main` 默认安装 Pi Research Dashboard。

## 在本机启动 Dashboard

在 Linux 上准备 Git、Node.js 22.19+、npm 和 pnpm 11.15.1。首次安装需要联网下载固定版本的 Pi、Dashboard 上游源码和依赖，并在本机构建前端。

```bash
git clone --branch main https://github.com/northkd/pi-research-harness.git
cd pi-research-harness
bash scripts/install.sh
./bin/pi-research-dashboard
```

打开 <http://127.0.0.1:8000/>。初次使用时，添加自己的研究目录；项目、历史会话和模型凭据不会随仓库安装。要从命令行启动会话，在另一个终端把克隆目录的 `bin/` 加入 `PATH`，进入研究项目后运行 `pi-research`，用 `/login` 登录、`/model` 选择模型。

研究工作台需要同步进程读取本机项目记录。先保持 Dashboard 运行，在第二个终端进入同一个克隆目录并运行：

```bash
./bin/pi-research-workbench-sync
```

## 查看会话和调度拓扑

- 左栏可以在紧凑和舒适两种密度间切换。文件夹名优先于父路径显示；舒适模式把模型名与用量分行，便于辨认同一目录下的会话。
- 打开项目的 **Agents** 页，在“调度拓扑”查看有记录的派发关系。用画布左下角的 `−` 缩小：空间足够时，同一父节点下的 Agent 会从一列排成多列。用“适应全部节点”回到全图。

## 独立宿主与 CLI

只需要 CLI 与独立宿主时，可在新的克隆中运行 `bash scripts/install.sh --host-only`，用 `./bin/pi-research-host` 启动。在仓库根目录查看命令说明：

```bash
./bin/pi-research host help
```

主 Agent 能查询子 Agent 的原生注册、派发状态和回执。会话、工作台和原始证据仍按项目保存，宿主重启后可读回已记录的状态。大历史的分页、待答问题和授权见接口文档。

- [安装与可选配置](docs/INSTALL.md)
- [CLI 与前端接口](extensions/research-host/API.md)
- [HTTPS 同源反代](extensions/research-host/deploy/README.md)
- [旧部署切换](extensions/research-host/migration/ROLLOUT.md)
- [主线监督](docs/SUPERVISION.md)
- [开发与验证](docs/DEVELOPMENT.md)

原有研究目录使用自己的科研记录和权限。模型凭据、会话文件与宿主运行状态保存在安装时选定的本机目录。

[变更记录](CHANGELOG.md) · [许可与上游声明](NOTICE)
