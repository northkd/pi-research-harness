# 快照验证记录

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

初始发布保持私有，有这些限制仍可以二次开发。不要用离线测试通过替代这些未做的实环境验证。
