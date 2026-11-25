# 安装与配置

默认安装 Web Dashboard 和锁定的 Pi 1.3.0。Linux 上需要 Git、Node.js 22.19+、npm、pnpm 11.15.1。首次安装会下载上游源码并在 `.runtime/dashboard-source` 构建；请在有足够内存和磁盘的机器上运行。已有 checkout 不会被覆盖。

```bash
bash scripts/install.sh --dry-run
bash scripts/install.sh
export PATH="$PWD/bin:$PATH"
pi-research-dashboard
```

浏览器打开 <http://127.0.0.1:8000/>。若只部署独立宿主，请在新的克隆中运行 `bash scripts/install.sh --host-only`，再运行 `./bin/pi-research-host`。

在另一个终端设置相同的 `PATH`，进入项目目录后运行 `pi-research`，在 Pi 中使用 `/login` 和 `/model`。`pi-research host help` 列出会话、工作台、目标、派发及其他本机接口命令。

安装脚本默认创建 `~/.local/share/pi-research-harness/agent`，也可在安装和启动前设置 `PI_RESEARCH_AGENT_DIR`。宿主配置默认写入 `.runtime/host`，可用 `PI_RESEARCH_HOST_DIR` 指向独立目录。安装时可用 `PI_RESEARCH_HOST_PORT` 修改默认端口 18768。宿主绑定回环地址，浏览器连接使用 [HTTPS 反代](../extensions/research-host/deploy/README.md)。

配置已有用户数据的机器，使用 [迁移与原始数据绑定说明](../extensions/research-host/migration/ROLLOUT.md)。附带的安装脚本需要新的 agent 配置目录。

研究工作台需要同步进程读取本机项目记录。先保持 Dashboard 运行，在第二个终端进入同一个克隆目录并运行：

```bash
./bin/pi-research-workbench-sync
```

## 可选浏览器 MCP

先自行安装 Chrome。需要桌面浏览器登录时，使用专用 profile：

```bash
pi-research-browser
```

该脚本仅绑定 loopback CDP 9222。登录由用户本人完成，不复制 cookie。
`config/browser-mcp.package.json` 固定 `chrome-devtools-mcp` 版本：

```bash
mkdir -p .runtime/browser-mcp
cp config/locks/browser/package.json .runtime/browser-mcp/package.json
cp config/locks/browser/package-lock.json .runtime/browser-mcp/package-lock.json
npm ci --prefix .runtime/browser-mcp --no-audit --no-fund
```

再参考 `config/mcp.example.json`，在本地 `mcp.json` 配置 Node 启动已安装的
`chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`，将`/ABSOLUTE/PATH`替换为自己的仓库路径，参数为
`--browserUrl=http://127.0.0.1:9222`。`build/src/index.js` 只是库入口，不会启动 MCP 服务，不要用它作为 command。
模板关闭使用统计和 CrUX。上传文件还需要按任务授权追加 `--filesystem-root=/path/to/allowed-drafts`；未配置时文件工具只允许临时目录。不要使用无限制根 `/`，也不要将文件搬到其他根绕过拒绝。在现有 agent 配置中增加服务器，而非用
`configure.mjs` 覆盖已有 settings。API 模型负责操作浏览器，不代表网页里的模型身份；必须核对实际网页模型。

## 可选绘图、外部 CLI 和计算

- `extensions/image-generation.ts` **默认不加载**。需要时配置自己的
  `CLIPROXY_BASE_URL` 和 `CLIPROXY_API_KEY`，再显式添加该 extension。发布版没有硬编码 key。
- agy 独立安装、独立登录。`agy-subagent` 是 stdin/stdout 适配器，不提供第三方凭据，也不承诺所有 agy 版本支持相同参数。
- 已许可的88个技能源码在`vendor/skills`，两个integration wrapper直接引用捆绑canonical文件。需要Pi发现时显式启用`--with-bundled-skills`；需要上游`~/.agents/skills`canonical路径时运行`install-skills.mjs`，拒绝覆盖非空目录。20个来源／许可待确认技能未复制。技能内提及外部MCP不等于本机可用；缺后端时停止，不声称完成LaTeX/PDF或独立审查。
- SSH/HPC 使用自己的 host alias。Slurm MCP 可选择上游
  [slurm-mcp-server](https://github.com/Charlie-Z-work/slurm-mcp-server)，不包含作者学校地址或远程访问授权。
