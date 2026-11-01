# 快照验证记录

> 以下内容记录旧快照；0.20 的当前安装和验证入口见 [0.20 开发与部署](RELEASE-0.20.md)。

日期：2026-10-12。验证仅说明以下范围，不替代任意新机/真实科研/浏览器/SSH的验收。

## 发布版离线门禁

- Node内置测试：**28/28通过**，包括integration契约、配置临时目录/拒绝覆盖/dry-run、扩展忙碌保护边界与发布补丁排除规则。
- Shell与ESM语法检查通过。
- 发布白名单与凭据模式检查通过；已知本机绘图凭据在待发布文件中匹配数为0。真实auth、provider配置、profile、sessions、research数据未复制。
- 两个dashboard补丁在固定上游源码上`git apply --check`及应用通过，**20个发布文件hash匹配**。
- `install.sh --dry-run`与`prepare-dashboard.sh --dry-run`通过；不访问模型、不安装依赖、不启动/restart/reload运行环境。

## 2026-10-13 迁移复核

- 从已发布 main 全新 clone，原有离线测试28/28、语法、白名单和dry-run通过。
- 隔离HOME/agent/cache实际执行旧安装脚本：Pi1.0.0可运行，但13个固定npm扩展未安装。虽然命令退出0，此项**不能算完整安装PASS**。
- 发布版修正固定包首次安装和浏览器MCP入口；修正后离线测试**32/32通过**。其中4个新增安装测试使用模拟npm过程，检查退出0但缺包不能通过、固定版本与过滤保护、check-only不安装。
- 浏览器固定版本实际bin入口的MCP initialize响应通过，旧库入口无响应。
- 本轮重新在固定上游源码应用两个补丁，20文件hash匹配。
- 该轮修正后13包实际安装未重跑：当时低于2GiB可用内存门槛；这是历史结果。随后源码补齐任务已完成新的隔离实际安装，见下一节。
- 详细迁移差异与必要步骤见 [MIGRATION.md](MIGRATION.md)。

## 2026-10-13 非敏感源码补齐与真实安装

- 固定upstream的fresh archive上，3个dashboard补丁check/apply通过，**29个源码文件SHA256匹配**；保留已知的一个EOF空白警告，不为消除warning修改既有快照。
- 真实隔离HOME/agent/cache安装：在资源门槛通过后执行锁定的`npm ci`，**333个包在42秒内安装，13个直接扩展的实际包名／版本逐项核验通过**；配置文件hash不变。
- 同次运行将发布的nested-route补丁应用到实际新下载的pi-subagents0.76.1，前后源hash匹配；再次check-only幂等通过。不是只用模拟fixture证明实际包可打补丁。
- 使用Pi1.0.0真实package-manager做**资源发现**：16个enabled扩展入口、259个技能资源来源、140个解析后的技能，自有integration和undo入口无缺失。
- 单独解析捆绑技能：**88个唯一技能，0解析diagnostic**；401个最终记录源码逐文件hash与原MIT／Apache许可证保留；两个独立LPPL-1.3的IEEEtran格式文件没有打包，明确由本人的TeX发行版提供，不误标MIT。
- 上述资源发现**没有执行扩展代码**，不能据此声称所有扩展启动、外部工具或认证工作流已验收。没有模型请求、网页登录、SSH/HPC、service启动或当前dashboard重启。
- 原创部分diff-check通过；第三方原文和许可证保留原CRLF／尾空白，以及patch context blank，由独立日志分类，不将其记为原创代码格式通过。
- 新增传递依赖完整性测试曾真实失败：Pi锁中7个精确1.0.0条目缺少integrity，保留该次48/49结果，不伪装全部通过。后续仅向npm官方核对固定name／version／tarball并补SHA512，不改版本、URL或放宽测试。
- 最终完整离线门禁：**49/49通过，0失败／0跳过**；shell／ESM语法、发布审计、完整可选flags的install dry-run与dashboard dry-run均通过，29源码hash复核通过。审计涵盖512文件，0findings；这是有界模式扫描，不是全面DLP保证。
- 最终检查不包含全新操作系统或dashboard完整重建。实际扩展安装与资源发现的通过范围如上；不将它们冒称全部扩展代码或认证工作流执行成功。
- 当前软件源码、配置与技能覆盖见[REPRODUCTION.md](REPRODUCTION.md)；20个来源／许可未确认技能没有复制，私人会话与研究数据仍排除。

## 2026-10-15 主线监管导出与文字布局修复

本轮发布副本与作者历史部署版分开验证。四源码/测试/SDK脚本去除机器路径与固定作者provider/model，精确模型由`PI_RESEARCH_SUPERVISOR_MODEL`指定，根Pi包发现新入口；原始与发布SHA分列于`config/mainline-supervision-source.json`，无私人项目状态/会话/真实review包。

- 首轮离线root49/49与监管core/policy/capture56/56；加入发布边界/source manifest及去继承尾空格后，当前完整离线**root58/58＋监管56/56**，实际installed host/public RPC **33/33**，0fail/0skip。不要与历史79/89重复相加或用旧部署测试替代适配版验收。
- 监管实际SDK no-model五项（cadence / proportional / bounded capture / log capacity / unauthorized runtime）全部PASS，loaderErrors=[]，没有native模型/子agent；cadence固定本地RPC mock合并2组真正节点，8轮同阶段收尾0追加审查。原生公开RPC实际加载不等于真实模型往返，后者本轮NOT_RUN。
- UI实际Chrome加载真实ChatView/NativeSubagents和完整Tailwind样式，360/768/1440px共**24/24布局场景、21/21预览/展开交互通过，errors=[]**。包括真实React流式state更新不重置展开、键盘展开/收起、全文源文本不变、短文无多余按钮、长链接/路径/行内可点击文件与代码/宽表局部滚动；最终增加UI标签不进入消息host innerText/plain-text复制的检查，修正后同24+21通过。
- 相同fixture修前确有溢出/截断。最初ESM/React依赖解析失败、忽略目录导致Tailwind扫描不全的无效轮次均本机保留，不把这些基础设施错误当成功复现。几何最终用应用既有reduced-motion模式排除装饰性shimmer伪元素的瞬态scrollWidth，文字/卡片布局规则未放宽；原失败也保留。
- 当前Dashboard静态部署只新增内容hash独立CSS/展开模块并改index引用，HTTP返回与验收SHA一致；**所有既有JavaScript/asset不变，无删除**，速度监控未被旧快照重建覆盖。service前后active且PID同值，未restart/reload会话、未触碰科研数据。本人刷新浏览器生效。
- 新增static installer验证dry-run无写、幂等/压缩一致、保留旧脚本/asset、拒symlink/malformed index；Node语法、发布模式审计与install/prepare dry-run通过。完整dashboard fresh build仍未重跑，29原source hash保持。
- 主动LSP检查5path仅2clean/3inconclusive，不宣称全面静态clean。没有独立新模型审查，不宣称科学验收/跨服务商验证或持久人工流程裁决已实现。

## 2026-10-18 当前开发源码同步

本轮仅发布源码，不部署Dashboard、不启动或继续真实目标。
GitHub API确认仓库当前 `visibility: private`；本轮不修改权限。
此前公开状态记录保留历史意义。

### 已确认检查

- 根离线测试 `61/61` 通过。
- 监管core／policy／capture测试 `56/56` 通过。
- Speed定向测试7文件 `86/86` 通过。
- 临时原版Hermes `0.1.0` 的9文件补丁dry-run／apply／check-only与幂等检查通过。
- 本地实际Pi `1.0.0` SDK离线测试 `23/23` 通过，网络调用 `0`。
- Shell／ESM语法与安装、Dashboard准备dry-run通过。

### 最终源码与Dashboard回归

4补丁manifest的169个文件SHA256全部匹配。
完整git tree回放与导出开发树逐字一致。
上述结果包含旧观察器测试计时修正后的最终复核。

Dashboard测试使用官方隔离 `npm test`。

| 执行范围 | 文件结果 | 用例结果 |
|---|---|---|
| 首轮41文件 | 37通过／4失败 | 590通过／7失败，共597；其中2个ChatView suite依赖未加载 |
| 补齐package-local依赖后，仅重跑4失败文件 | 2通过／2失败 | 107通过／7失败，共114；恢复的2个ChatView文件24用例全过 |
| 按文件与用例去重后的41文件覆盖 | 39通过／2失败 | 614通过／7失败，共621 |

最终覆盖合并首轮未受影响文件与4文件重跑结果，不累加重复用例。
`614/621` 表示合并去重覆盖，不表示一次全量执行无失败。
剩余2失败文件共90用例，83通过／7失败。
原开发树官方隔离对照同样83通过／7失败，失败名称逐项一致。

- `SettingsPanel` 5项既有失败：alias保存、default model thinking、session-only、catalogue fallback、union。
- 未部署R3-B1历史重放候选2项既有失败：`navigation supersedes retry`、`retry exhaustion`保持已知良好history。

本轮不扩修上述7项，按实际失败保存开发快照，不标记稳定发布。

### 原始失败与处理

- Node沙箱测试遇到 `EPERM`；保留原失败，改在主机本地执行后通过。
- 直接Vitest调用被HOME隔离tripwire拒绝；未触碰真实会话。
- 导出副本缺少package-local workspace links，导致12个suite加载失败；随后仅补临时依赖链接。
- 一轮Dashboard定向测试记录 `280 passed + 1 failed`；失败位于旧 `native-subagent-observer.test.ts` 首用例。
- 该用例推进 `5000ms`，先触发 `4000ms` 超时，造成错误归因；仅改测试推进值为 `1000ms`，运行代码不变。
- `pnpm 11.15.1 --offline` 仍尝试2113条供应链metadata，DNS返回 `EAI_AGAIN`；主动终止，未记作安装成功。
- 锁文件仅对齐新增speed importer与client link；既有package解析核对无变化。

本轮未执行完整依赖安装、frozen install或fresh build。
离线测试与源码一致性不代表新机部署、模型认证或科研验收。
本轮结果保留7项既有失败；源码一致性通过不消除功能失败。

## 当前可用环境的来源证据

已部署最小dashboard前端的定向测试25通过、2跳过；前端production TypeScript检查通过（不含testonly源文件）；实际Vite构建及预压缩通过。运行环境health/index/JS资源SHA核验通过。

撤回编辑附加验证使用真实App/ChatView/可编辑CommandInput与模拟transport，验证最后消息回填、手动编辑重发、旧回复退出当前列表；另验证生成中禁撤回和底层命令忙碌立即拒绝。

Dashboard源补丁来自这次部署使用的前端stage，而不是尚未验收的R4后端候选。`config/snapshot.json`保存源码来源与hash，不能把重新build出的asset名字固定一致当作跨平台保证。

## 尚未执行或不能承诺

- 在全新操作系统上安装所有npm/Pi插件并使用真实认证模型。
- 所有型号、推理档位、外部CLI版本及网页模型的等价性。
- 真实科研结论、完整论文PDF审查或HPC实验复现。
- 任意历史分支编辑、所有刷新/断线重连及复杂running-tool重放。
- 自动进程/扩展沙箱隔离；工具白名单不是安全沙箱。

仓库初始为私有；2026-10-13所有者确认已自行改为公开，并批准本次审查后的源码保持公开。以上验证限制不因公开而改变。不要用离线测试通过替代这些未做的实环境验证。
