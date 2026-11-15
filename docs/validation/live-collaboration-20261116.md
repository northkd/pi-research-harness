# 实时协作开发验收记录

日期：2026-11-16（北京时间）。目标分支：`feat/autonomous-collaboration-20261106`。
基础提交：`7ef65ba2ac90dd734860ad4d6fd717ff0826c026`。
上游 Dashboard 固定提交：`65dc4558c7b07ef755ee4f0eda89d9f63e7e76e0`。

## 已实际执行

| 检查 | 结果 |
|---|---|
| `PI_RESEARCH_DASHBOARD_SOURCE=<prepared-runtime> npm test` | 主测试 495 passed / 1 skipped；监督测试 64 passed；0 failed |
| Dashboard 研究组件、参与者及注册回归 | 30 文件、335 passed |
| Dashboard 真实 Fastify 协作路由测试 | 1 文件、4 passed |
| 最终预览 fixture / 默认启动参数测试 | 5 passed（已包含于主测试，不重复计入总数） |
| Dashboard `npm run lint` | TypeScript 全量检查 exit 0 |
| 最终生产客户端构建 | 5,932 modules；52.10 秒；exit 0 |
| Overlay 安装校验 | 687 files；changed 0 |
| 隔离原生服务器 + 最新客户端构建 | `clientBuild.status=matched`；7 条合成会话与真实目录逐 ID 对齐 |
| 真实认证 HTTP 协作验收 | 下述 6 项全部通过 |

独立仓库目录未安装可选 Pi SDK，因此 `installed Pi SessionManager ...` 一项显式跳过；
并非将未执行检查算成通过。运行树已就绪，另外两个依赖运行树的测试没有跳过。

首次最终构建在 Node 默认约 2 GB 堆限制处内存不足；确认主机可用内存后，使用
`NODE_OPTIONS=--max-old-space-size=4096` 重跑成功。这是本次构建参数，不改服务内存上限。
保留上游 minimatch default export、混合动态导入和较大 chunk 警告，未将其掩盖为无警告构建。

## 真实 HTTP 验收范围

采用仓库 `scripts/ui-preview/launcher.mjs run --runtime <prepared-runtime> --output <new-output> --api-only`，
默认使用新的协作 fixture，不替换 HTTP 或 WebSocket 返回值。依次核对：

1. 服务端当前／历史 2 个任期、4 个同级 Multi、持久任务 DAG 和原生候补队列。
2. 真实 workbench shared-schema，以及 4 条有准确父记录的下属执行。
3. 真实研究接口中的完整目标、约束与范围之外字段。
4. 并发配置修改、旧 revision 返回 HTTP 409、再次读取与恢复配置。
5. 移除历史主 Agent 级联其旧任期，不影响当前绑定及当前分支。
6. 移除当前主 Agent 清除绑定并级联其分发，同时保留全部 7 条会话转录文件。

初始 4 项计划任务均为真实 queued：3 项等待容量、1 项等待依赖。
所有输入是明确标注的合成数据，模型调用数为 0；测试不会向用户线上项目派发工作。
运行结束后停止自有进程并清理临时私有目录。

## 尚未完成：真实浏览器视觉确认

本次 Chromium 启动被环境以 `socket() EPERM` 拒绝；外部浏览器也不能访问该执行进程的隔离 loopback。
因此所有报告明确标记 `visualVerification=not-performed`，没有运行截图，不宣称与设计稿逐像素一致。
组件测试、布局几何和 API 测试不能替代此项验收。

已提供默认的真实浏览器检查脚本 `scripts/ui-preview/collaboration-browser-qa.mjs`，
用于在允许运行浏览器的授权主机检查 1920 / 1440 / 1100 / 768 / 360 px 布局、
模型来源、当前历史分区、并发弹窗及目标与约束展开内容。
脚本存在不代表本次执行了浏览器检查；参考 [隔离验收说明](../../scripts/ui-preview/README.md)。

代码同步不等于更新线上部署。本次没有切换用户服务器的运行版本，也没有改动其真实会话、凭证或任务。
