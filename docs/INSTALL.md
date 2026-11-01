# 安装与配置

> 以下内容记录旧快照；0.20 的当前安装和验证入口见 [0.20 开发与部署](RELEASE-0.20.md)。

本快照优先支持 Linux。推荐 Node.js **22.19+**、npm、Git；dashboard 源码重建还需要 **pnpm 11.15.1**。Chrome、LaTeX、SSH、agy 和外部技能包均按需安装，不是核心启动条件。

## 1. 克隆与检查

仓库现为公开，可直接克隆：

```bash
git clone https://github.com/northkd/pi-research-harness.git
cd pi-research-harness
npm test
npm run check:release
bash scripts/install.sh --dry-run
```

离线测试不需要提供 API key。仓库没有保存任何模型登录信息。

## 2. 创建独立科研配置

```bash
bash scripts/install.sh
export PATH="$PWD/bin:$PATH"
pi-research
```

安装脚本下载固定的 Pi 1.0.0，配置目录默认是
`~/.local/share/pi-research-harness/agent`，运行依赖位于仓库的 `.runtime/`。
它拒绝覆盖已有 `settings.json`，不复制个人 `auth.json`、会话或 browser profile。固定版本扩展会用发布的传递依赖锁执行`npm ci`到隔离 agent 的 `npm/`，并逐项核对实际版本，再应用hash保护的subagents源补丁，而不是仅运行更新命令。
如果初次安装中断，不要覆盖已经创建的配置。下面命令只允许空的npm安装目录，或已完整安装的13包；非空但不完整的目录会拒绝，避免npm ci静默删除无关包。需本人先审查并隔离该不完整目录，再继续：

```bash
node scripts/install-packages.mjs "$PI_RESEARCH_AGENT_DIR"
node scripts/install-packages.mjs "$PI_RESEARCH_AGENT_DIR" --check-only
node scripts/apply-subagents-patch.mjs "$PI_RESEARCH_AGENT_DIR"
node scripts/apply-subagents-patch.mjs "$PI_RESEARCH_AGENT_DIR" --check-only
```

未设置 `PI_RESEARCH_AGENT_DIR` 时，将参数换成实际的隔离 agent 绝对路径。

使用独立目录时：

```bash
export PI_RESEARCH_AGENT_DIR="$HOME/.local/share/my-research-agent"
bash scripts/install.sh
pi-research
```

在 Pi 内执行 `/login`、`/model`，选择自己确实可以使用的模型。角色配置默认不绑定作者的代理账号或模型；需要独立模型时，在 `agents/research-*.md` 的本地副本中填真实 `provider/model-id`。

兼容代理示例是 `config/models.example.json`。将本地 agent 目录中的
`models.example.json` 复制为 `models.json`，修改 endpoint 和 model ID，并在启动 shell 设置 `RESEARCH_API_KEY`。不要提交实际 `models.json` 或 key。

## 阶段式后台主线监督

主线监督extension已随根Pi包注册；没有项目配置时保持dormant，不自动外发或启动模型。新配置会复制只读`research-mainline-supervisor`角色。启动前显式设置本人的认证模型：

```bash
export PI_RESEARCH_SUPERVISOR_MODEL='your-provider/your-model:high'
pi-research
```

先在目标项目查看`mainline_supervision status`；已有配置不重设核心或历史权限。新项目由主agent登记用户确认的core与最小证据范围，经直接UI一次授权。真正研究节点用稳定stageId的checkpoint，同阶段改代码/测试返回/收尾只积累证据；不需要为确认安装运行check。已有Pi完成当前工作后自行`/reload`、`/mainline-supervision status`，不自动替其他会话reload。详见[监督设置与边界](SUPERVISION.md)。

## 3. 可选：dashboard 及已经部署的定制

```bash
bash scripts/prepare-dashboard.sh --dry-run
bash scripts/prepare-dashboard.sh
```

该命令单独克隆上游并 checkout `config/snapshot.json` 的固定提交，检查并应用三个补丁并核对29源文件hash，再执行固定锁文件安装与真实前端构建，最后添加内容hash命名的`text-containment.css`及`content-folding.mjs`。长正文/URL/路径换行；长内容默认限高预览，可「展开全文 / 收起」，短内容不折叠，代码/表格内部横向滚动；不改变会话/消息原文。**不会启动服务、reload Pi 或重启别的 dashboard。**

在独立 agent 的 `settings.json.packages` 添加：

```text
/path/to/pi-research-harness/.runtime/dashboard-source/packages/extension
```

新启动的 `pi-research` 会加载 bridge。已有 Pi 需要在空闲时自行 `/reload`。
然后运行：

```bash
pi-research-dashboard
```

界面默认绑定 `127.0.0.1:8000`，Pi gateway 默认 9999，不启用公网 tunnel。
远程访问推荐 SSH 转发：

```bash
ssh -L 8000:127.0.0.1:8000 your-server
```

浏览器打开 `http://127.0.0.1:8000`。不要把无鉴权的管理接口直接暴露公网。

四个可选plugin bridge、KB/project配置及服务模板见[复刻清单](REPRODUCTION.md)。全新安装可用`bash scripts/install.sh --with-dashboard-plugins --with-browser --with-bundled-skills`，或仅创建新的配置用`configure.mjs`及同flags。已有配置只手工合并，不重跑configure覆盖；可选入口不会自动准备或启动dashboard/browser服务。

`config/dashboard.example.json` 是配置参考，不会覆盖现有 `~/.pi/dashboard/config.json`。
Dashboard 自身的运行数据位置仍由上游控制，和本仓库隔离；在已有 dashboard 的机器上先确认端口与数据目录，不并行启动同端口实例。

## 4. 可选：真实浏览器 MCP

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

## 5. 可选：绘图、外部CLI与学校计算

- `extensions/image-generation.ts` **默认不加载**。需要时配置自己的
  `CLIPROXY_BASE_URL` 和 `CLIPROXY_API_KEY`，再显式添加该 extension。发布版没有硬编码 key。
- agy 独立安装、独立登录。`agy-subagent` 是 stdin/stdout 适配器，不提供第三方凭据，也不承诺所有 agy 版本支持相同参数。
- 已许可的88个技能源码在`vendor/skills`，两个integration wrapper直接引用捆绑canonical文件。需要Pi发现时显式启用`--with-bundled-skills`；需要上游`~/.agents/skills`canonical路径时运行`install-skills.mjs`，拒绝覆盖非空目录。20个来源／许可待确认技能未复制。技能内提及外部MCP不等于本机可用；缺后端时停止，不声称完成LaTeX/PDF或独立审查。
- SSH/HPC 使用自己的 host alias。Slurm MCP 可选择上游
  [slurm-mcp-server](https://github.com/Charlie-Z-work/slurm-mcp-server)，不包含作者学校地址或远程访问授权。

## 升级和重启

不要把配置目录或 `node_modules` 当作升级包。先记录当前版本/补丁/hash，再检查上游兼容性。服务重启可能终止同一 systemd control group 内的 Pi 会话；部署执行器应独立运行，保存结果和回滚记录。**本仓库不会自动执行你机器的 systemd restart 或全局 Pi reload。**

可移植安装脚本已做离线与临时目录验证，但本次发布没有在一个新机器上完成有认证的全量安装、网页登录或 HPC 实验，不能把这些列为已验证能力。
