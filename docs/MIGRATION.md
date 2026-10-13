# 换设备：复刻软件与迁移私人状态分开

## 当前结论

此前遗漏的可发布源码已补齐：**3个dashboard补丁／29个文件hash、subagents本地源补丁、路由实现、插件／KB／服务模板、传递依赖锁，以及88个技能及辅助源码**。具体对应关系见[REPRODUCTION.md](REPRODUCTION.md)。

因此不再把“这些普通源码没有上传”当作无法复刻的默认理由。新设备可按固定来源恢复已保存的软件部分。另一方面，**源码完整性不等于实际安装／构建成功，也不等于已配置的认证模型、网页和远程科研状态**；本仓库不是整机私有镜像。

## 可恢复范围

| 组成 | 保存与安装方式 | 必须分开验收的事项 |
|---|---|---|
| Pi 1.0.0与13扩展 | `config/locks/`／`npm ci`、逐项实际manifest核验 | 扩展发现、加载和真实工作流 |
| 自有integration／undo | 自有源码；undo保留忙碌立即拒绝 | 真实会话操作权限、外部效果不可撤回 |
| Dashboard | 固定upstream，3补丁及29hash；第三patch取actual shared reader | 匹配pnpm、fresh build、自己的bridge与启动端口 |
| 子代理nested async身份 | 0.76.1精确源hash、MITpatch与幂等应用脚本 | 实际嵌套子任务生命周期，不能从patch应用推断全部编排正确 |
| Plugin bridge／KB／服务 | 新设备绝对路径生成、独立KB配置及systemd/loopback proxy模板 | 浏览器UI/server插件加载、自己的知识源/index/远程访问策略 |
| 外部skills | 88份源及许可、每文件来源hash；显式发现/canonical installer | 20份来源未明技能未复制；特定helper外部工具／MCP仍需准备 |
| 路由与history功能 | 两实现文件、默认禁用空池示例、synthetic测试 | 本人的授权provider、实际型号目录、可信额度证据；无自动定时后台服务 |
| 非模型runtime参数 | compaction与原生thinking覆盖写入新模板 | 账号默认模型不复制，别将参数一致等同上下文行为完全等价 |

原始`integration/src`三个模块和undo仍与本机一致；两个薄wrapper为了消除私有canonical路径依赖改为指向已捆绑源，这是一项明确发布版可移植改动。

## 仍需新设备自行准备

1. **模型认证和实际可用目录**：本人的provider/model，不能复制作者账号映射或把公开技能写的型号当作已认证。
2. **网页**：Chrome／桌面／专用profile、本人登录、loopback CDP、任务最小文件授权根，核验页面实际模型。
3. **SSH／Slurm／agy／TeX等工具**：安装、本人认证、允许目标和资源环境；安装仓库不自动授权远程作业或材料外发。
4. **服务及访问**：端口、systemd、HTTPS或者SSH转发；模板不含作者服务器地址或认证密码。
5. **私人研究状态**：会话、长期记忆、论文、原始输入输出、KB索引另做加密点对点迁移及路径重映射，不能塞入GitHub。
6. **来源／许可未知的20个技能**：清单和主文件hash已保存，尚无分发许可证据时不复制；可由有权用户另行私下迁移。

## 安装问题的历史与修正

最初fresh remote clone运行旧installer时，离线测试28/28、命令exit0、Pi版本1.0.0都通过，但13扩展manifest全不存在。**该原始运行仍保留为完整安装失败**，不因为后续代码改了就改写历史。

Pi 1.0.0的`update --extensions`跳过精确固定npm来源；该次检查还用了PI_OFFLINE使update提前返回。第一次修正显式npm安装并验证manifest（32离线用例通过），当时资源不足未重装。当前进一步保存实际传递依赖锁、使用npm ci，并显式应用hash保护的subagents源补丁。完整安装的最终结果以[VALIDATION.md](VALIDATION.md)为准。

若安装中断，已有settings不覆盖。非空但不完整的npm目录需要本人先审查并隔离，再继续锁安装；工具不会自动删除其中的无关包。

## 浏览器入口

旧`chrome-devtools-mcp/build/src/index.js`只是库，执行exit0不等于MCP可运行。已修为固定1.10.1实际bin入口：

```text
chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
```

实际initialize握手已核对；模板关闭使用统计／CrUX，只按任务授予文件目录，不开无限制根、不搬文件绕过拒绝。

## 新设备步骤

1. Linux／Node≥22.19、Git、npm、Python3和Bash；Windows/macOS原生运行未验证。
2. clone **最新main**，运行离线test/syntax/release与install dry-run。`v0.1.0`保留初始快照，不含后续补齐。
3. 新的`PI_RESEARCH_AGENT_DIR`安装；manifest和subagents patch check-only逐项通过后，再检查扩展发现／加载。
4. 根据[REPRODUCTION.md](REPRODUCTION.md)显式启用所需skills、四bridge／browser；不覆盖个人旧配置。
5. 需要dashboard时准备pnpm11.15.1，固定HEAD应用3patch/29hash后fresh build；服务启动由本人决定。
6. 配自己的模型，执行不含私人材料的小任务。依次验证浏览器、external reviewer、SSH等需要的功能，不批量未经授权调用。
7. 软件可用后再私下迁移已有研究状态，核对hash与路径。

本轮同机隔离HOME／agent／cache不是实际第二台设备测试。没有新的科研模型调用、SSH/HPC作业或运行dashboard部署。**保存更多源码已经完成实质改进；完整可用性仍必须用实际验收来证明。**
