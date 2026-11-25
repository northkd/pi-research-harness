# 二次开发

`extensions/research-host` 提供回环 HTTP、WebSocket、模型设置、原生会话和派发宿主。`extensions/research-loop` 维护研究状态和工作台同步，`integration` 提供证据工作流。CLI 入口在 `bin`。

```bash
bash scripts/install.sh
npm test
npm run check:syntax
npm run check:release
```

安装完成后的测试覆盖独立宿主及 Pi 运行时。接口联调使用临时目录和合成会话。可通过 `PI_RESEARCH_TEST_CADDY` 指定本机 Caddy 来运行反代测试。新前端使用 [HTTP 和 WebSocket 接口](../extensions/research-host/API.md)。`config/dashboard-v020.json` 固定 Dashboard 上游提交，并逐文件记录 `patches/dashboard-v0.20/overlay/` 的源码摘要。`scripts/prepare-dashboard.sh` 将覆盖文件应用到新的 checkout；安装完成后可用 `node scripts/apply-dashboard-v020.mjs .runtime/dashboard-source --verify` 复核。历史快照见 [0.20 分支](https://github.com/northkd/pi-research-harness/tree/0.20)。

## 主线监督开发

`extensions/mainline-supervision`保存可移植policy2/cadence1，启动模型仅由本地`PI_RESEARCH_SUPERVISOR_MODEL`与项目直接UI授权决定。`npm test`包含无依赖合成core/policy/capture测试；`test:supervision:host`使用已安装Pi的peer aliases与真实public RPC、mock executor；`test:supervision:sdk`运行五项实际SDK no-model检查。明确缺依赖报错而非skip或自动安装。SDK检查不替代真实认证模型往返，不引用作者历史通过冒充当前版验收。见[SUPERVISION.md](SUPERVISION.md)。

固定capture host source清单适配根Pi包发现，不包括本机standalone安装wrapper。源文件导出hash/适配理由位于`config/mainline-supervision-source.json`；不能以旧部署hash证明改后的发布版。

## 子代理、依赖与技能快照

`apply-subagents-patch.mjs`限定pi-subagents0.76.1和原始／目标SHA256，拒绝未知内容，幂等检查后再应用。不要为兼容升级而删掉hash保护。依赖锁保存直接及传递包版本／integrity，不收录node_modules；npm ci遇到非空未知安装目录会停止。

技能保留原许可证和来源状态。修改vendor文件须同步明确`config/skill-provenance.json`新hash及本地改动原因，不能保留旧hash谎称原文。显式install-skills拒绝已有目录；默认不执行源内脚本、hook或外部reviewer。若需恢复20个未知来源技能，先补足来源／许可，而不是把私有目录整树上传。

## 添加模型/服务

示例配置不绑定作者账号。用自己的 `/login` 和 registry 选择真实可用模型，或配置环境变量。所有真实 auth、cookies、SSH host、provider配置必须留在 `.runtime/` 或独立 agent 目录之外的忽略路径，不写入 tracked 文件。

默认模型 thinking 为 max；external CLI 角色按自身runner合同，不能伪造native thinking 支持。内存较小的机器要降低并发，而不是把heap上限当作aggregate RSS保证。

## 发布

1. 只发布白名单资产；不提交 `.runtime`、日志、论文数据、auth、session。
2. 新截图只在独立浏览器中脱敏，目视核验，不改变真实会话。
3. 记录可复现的上游提交、依赖版本、完整源码hash及部署／未验证边界。
4. 执行离线门禁与敏感信息检查，再commit/tag/push。

仓库现已由所有者改为公开，已审查源码获准公开。后续新增内容仍须复核许可证和数据授权；公开或私有仓库都不是存储凭据的地方。
