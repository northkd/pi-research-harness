# 快照验证记录

日期：2026-10-12。验证仅说明以下范围，不替代任意新机/真实科研/浏览器/SSH的验收。

## 发布版离线门禁

- Node内置测试：**28/28通过**，包括integration契约、配置临时目录/拒绝覆盖/dry-run、扩展忙碌保护边界与发布补丁排除规则。
- Shell与ESM语法检查通过。
- 发布白名单与凭据模式检查通过；已知本机绘图凭据在待发布文件中匹配数为0。真实auth、provider配置、profile、sessions、research数据未复制。
- 两个dashboard补丁在固定上游源码上`git apply --check`及应用通过，**20个发布文件hash匹配**。
- `install.sh --dry-run`与`prepare-dashboard.sh --dry-run`通过；不访问模型、不安装依赖、不启动/restart/reload运行环境。

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
