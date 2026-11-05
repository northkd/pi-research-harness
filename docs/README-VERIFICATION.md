# README 与流程配图核查

核查日期：2026-11-05。源码基线：[`b79930abc23c7f5a93bc61e83979b25a5219bdea`](https://github.com/northkd/pi-research-harness/commit/b79930abc23c7f5a93bc61e83979b25a5219bdea)，即 `feat/research-workspace-ui-20261105` 的 UI 改版提交。

本轮重写项目介绍与配图，按当前安装脚本、运行入口、科研扩展、Dashboard 覆盖层和已有验证记录核对功能。文档与图片更新不等于修复业务代码、部署服务器或完成真实研究任务。

## 核查范围与依据

| 核查对象 | 已确认的源码事实 | 依据 |
|---|---|---|
| 当前版本 | Harness 0.20.0；Pi 1.3.0；pi-subagents 0.79.2；Dashboard 上游 v0.10.0 固定提交加源码覆盖层。 | [包元数据](../package.json)、[Pi 锁定依赖](../config/locks/pi/package.json)、[扩展锁定依赖](../config/locks/extensions/package.json)、[覆盖层清单](../config/dashboard-v020.json) |
| 初次安装 | 安装 Pi 和 13 个锁定 npm 包，注册本仓库扩展并复制角色；拒绝覆盖已有配置。安装器不是升级命令。 | [install.sh](../scripts/install.sh)、[configure.mjs](../scripts/configure.mjs)、[install-packages.mjs](../scripts/install-packages.mjs) |
| 技能与角色 | 仓库保存 88 个技能源码和 10 个角色模板；捆绑技能需显式启用；技能文件不提供外部服务凭据。 | [技能来源清单](../config/skill-provenance.json)、[角色目录](../agents/)、[配置生成器](../scripts/configure.mjs) |
| 自动科研范围 | `auto-research.js` 串联探索、筛选与规划、实验、评审，即 Stage 1–3；Stage 4 总结与 Stage 5 写作在阶段映射中定义，未由该脚本继续执行。 | [自动流程](../extensions/research-loop/workflows/auto-research.js)、[阶段映射](../extensions/research-loop/stage-role-skill.json) |
| 评审结果 | 自动流程可返回 `converged` 等运行状态；循环传递评审记忆，没有在轮次之间自动执行修复和重跑实验。其评分不能代替科学证据验收。 | [自动流程 Stage 3](../extensions/research-loop/workflows/auto-research.js)、[评审器](../extensions/research-loop/src/reviewer.mjs) |
| 独立配置与运行树 | agent 默认在用户目录，Pi 和 Dashboard 依赖在仓库 `.runtime/`；Dashboard 上游运行数据仍另有目录。构建不启动或重启服务。 | [CLI 入口](../bin/pi-research)、[Dashboard 入口](../bin/pi-research-dashboard)、[准备脚本](../scripts/prepare-dashboard.sh) |
| 本地认证 | Dashboard 默认前台启动；`open --print --url` 通过原生 local-proof 流程输出短时登录链接，应在另一终端运行。 | [Dashboard CLI](../patches/dashboard-v0.20/overlay/packages/server/src/cli.ts) |
| 观测同步 | 同步服务监听 `127.0.0.1:18767`，读取同用户的 Dashboard 本地令牌及指定 agent 的会话；服务本身不启动模型或任务。 | [同步启动器](../scripts/workbench-sync-launch.mjs)、[同步服务](../extensions/research-loop/src/workbench-sync-server.mjs) |

## 初次安装的前置条件

- 准备 Bash、Git、Python 3、Node.js 22.19+ 和 npm；构建 Dashboard 还需 pnpm，准备脚本提示版本为 11.15.1。
- 克隆/检出分支必须包含所介绍的 UI 提交；仅克隆尚未合并这些改动的 `main`，无法得到同一界面。
- 选择新的空 agent 目录。需要 Dashboard 时初装带 `--with-dashboard`；需要捆绑技能发现时带 `--with-bundled-skills`。
- `--with-dashboard-plugins` 可替代 `--with-dashboard`，额外注册四个可选 bridge；不表示其外部服务已配置或自动化已获授权。
- 若自定义 agent 或 Dashboard 源码位置，在生成配置、构建和启动时使用一致的绝对路径。构建目标目录须不存在。
- 使用 `/login`、`/model` 配置本人实际可用的模型。模型目录同步只能确认可见 ID，不证明真实推理、评审角色匹配或账号额度。
- Dashboard、浏览器认证命令及同步服务使用相同用户、`HOME`、agent 目录与端口。认证链接不应保存到文档或截图。
- macOS 有构建/显示记录；部分资源准入依赖 Linux `/proc/meminfo`。不能据此承诺 macOS、Windows 或 WSL2 的全部科研工作流已验收。

## 必须在介绍和配图中保留的当前缺口

| 缺口 | 影响与不能作出的承诺 | 源码或已有证据 |
|---|---|---|
| 三个角色未随模板提供 | 流程/策略引用 `research-explorer`、`research-strategist`、`research-reframer`，但 `agents/` 没有对应模板，安装器也不生成它们。不能宣称全新安装即可跑通自动科研链。 | [安装器复制逻辑](../scripts/configure.mjs)、[角色目录](../agents/)、[自动流程](../extensions/research-loop/workflows/auto-research.js)、[阶段映射](../extensions/research-loop/stage-role-skill.json) |
| 后端根目录解析不一致 | wrapper 导出 `PI_RESEARCH_LOOP_ROOT`，resolver 却只搜索祖先下的 `research-loop`，不读取该变量；默认目录布局可能报 `research-backend-unavailable`。单补 `export` 不能修复。 | [wrapper](../bin/pi-research-dashboard)、[adoption-service.ts](../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/adoption-service.ts)、[既有测试](../tests/dashboard-route-isolation.integration.mjs) |
| 同步代理身份与准入协议不一致 | workbench-sync 代理未使用其他研究路由的统一 cwd/owner 准入，也未按同步服务要求转发调用者分类与身份。不能把本地 fallback 当作权限验证，或通过删断言宣称通过。 | [路由实现](../patches/dashboard-v0.20/overlay/packages/server/src/routes/res-workflow-routes.ts)、[同步服务](../extensions/research-loop/src/workbench-sync-server.mjs)、[基线复现说明](ui-redesign/feature-preservation.md) |
| Science 仍需独立环境 | 保留查看入口和 host/worker 源码，不代表新安装已有可用 Science 服务，也不代表 Pi 自动把研究任务派给 Science。 | [0.20 边界说明](RELEASE-0.20.md)、[UI 实施与验证](ui-redesign/implementation.md) |
| 外部运行尚未全量验收 | 付费模型、真实 Pi bridge、远程 PTY/计算、Science 与各插件端到端执行不能由合成截图或离线测试替代。 | [UI 实施与验证](ui-redesign/implementation.md)、[验证记录](ui-redesign/validation.json) |

上述两项路由集成失败已在 UI 改版前的 `af2810437` 基线重放，属于保留的服务端问题。本轮文档不将其修复，也不把它们降为纯测试误报。见[完整核查与原始证据](ui-redesign/feature-preservation.md)。

## 本次核查与已有测试分开记录

| 类型 | 状态与适用范围 |
|---|---|
| 本次源码核查 | 已读取并比对当前入口、依赖锁、配置生成、阶段脚本、角色文件、路由实现与既有审计。结论仅覆盖所列源码行为。 |
| 既有 UI 验证记录 | `docs/ui-redesign/validation.json` 记录构建、610 文件覆盖层校验、25 项无头浏览器检查、233 项 harness 和 63 项 supervision offline 检查；这些是之前 UI 改版的记录。 |
| 既有未通过项 | 全仓 TypeScript 仍有未修改服务端文件诊断；独立路由隔离检查在原基线和 UI 分支均有两项失败。不能把前端构建通过写成全仓类型或后端门禁通过。 |
| 本次文档/配图验证 | 4 份 Markdown 的 210 个本地链接与锚点检查通过。无头 Chromium 在 1440、900、390 像素宽度下渲染根 README：各 5 张图片正常加载，无页面横向溢出、无页面错误。三张流程图经源码映射复核及人工视觉检查；独立重跑绘图脚本得到的 3 张 PNG 和 3 张 SVG 均与提交文件逐字节一致。 |
| 本次运行测试 | 使用已准备的固定 Dashboard 运行树，重新执行 `npm test`：Harness 233/233、监督离线 63/63 通过，均无失败、无跳过。语法检查、带 Dashboard 与捆绑技能的安装 dry-run、Dashboard 准备 dry-run 通过；README 的 11 个 Bash 代码块经 `bash -n` 通过。`check:release` 扫描 1,273 个文件，返回零项发现；`git diff --check` 通过。未重新构建产品，未启动真实模型、远程作业或生产服务。 |

根 `npm test` 在缺少已准备 Dashboard 源码时会跳过 stage-session-spawn 集成项。CI 的离线检查、语法检查和 dry-run 不等于有认证的新机全量验收；UI 定向测试组有重叠，也不能累加成唯一用例总数。依据：[测试入口](../scripts/run-tests.mjs)、[可跳过的集成项](../tests/stage-session-spawn.test.mjs)、[CI](../.github/workflows/ci.yml)。

## 图片的验收标准

1. 执行箭头必须对应入口/调用/返回关系；观测、状态同步和源码配置关系应分别标明，不能画成已运行任务。
2. 自动 Stage 1–3、后续 Stage 4/5、可选外部后端与未补齐前置要清楚区分；不得画成无条件的一键五阶段闭环。
3. 研究输出应保留原始产物、证据路径与未定/失败状态；流程完成、模型评分或界面卡片不代表科研结论成立。
4. 产品界面使用实际构建截图，并注明合成演示数据；结构图标明依据源码绘制。两类图都不能作为实验结果证据。
5. 图的文字、箭头与 README 使用同一套名称；保存可编辑来源和可重新生成的图片，便于后续版本核对。

图片来源、生成方法和源码映射见[配图说明](images/README.md)；当前功能入口与安装说明见[根 README](../README.md)。
