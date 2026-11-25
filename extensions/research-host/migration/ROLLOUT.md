# 本机 Dashboard 退役事务

`createMachineRolloutPlan()` 只读检查这台机器的精确路径、配置 SHA-256、旧模块链接、独立 Pi 安装和旧 Caddy。默认使用没有前端目录的 HTTPS 入口：认证后的 `/` 返回真实宿主 health，`/api/*` 和 `/ws` 保留同源访问。原 Caddy CA 存储和 IP `default_sni` 保留。

```js
import { createMachineRolloutPlan, stageRolloutArtifacts, runRollout, rollbackRollout } from './rollout.mjs';
import { createSystemdRolloutAdapter } from './rollout-systemd.mjs';
import { seedRuntimeState, rollbackRuntimeState } from './runtime-state.mjs';

const plan = createMachineRolloutPlan();
const bundle = stageRolloutArtifacts(plan); // 仅在工作区私有 backup 中生成文件及新 token
const adapter = createSystemdRolloutAdapter({
  assertNativeQuiescent, verifyHealth, verifyProofs, verifyRestart, quiesceNewSessions,
});
await adapter.preflight();
const result = await runRollout({ plan, bundle, adapter, seedRuntimeState,
  expectedPlanSha256: plan.planSha256 });

// 显式回滚；也用于进程中断后从持久 journal 恢复。
// await rollbackRollout({ journalPath: result.journalFile, adapter, rollbackRuntimeState });
```

systemd adapter 固定调用 `/usr/bin/systemctl --user`，显式指定当前 UID 的 `/run/user/<uid>/bus`，仅操作三个旧 unit 和两个新 unit。所有 proof 回调必须返回 `{ok:true,evidence:[...]}`。回调收到 `{plan,bundle,adapter}`；health/proofs/restart 另含 `publicReady`，quiescence 含 `phase`。`quiesceNewSessions` 必须在新宿主尚未安装时也能安全确认无新 worker。

事务停止旧服务，校验并保存原状态，安装独立启动器、系统服务、Caddy 和模块链接，再初始化新宿主状态。验收期间暂停后台调度和写入。逐条验证原有会话和旧链接，完成宿主重启及 HTTPS 检查后，移走旧程序并恢复调度。新凭据、配置备份和事务记录使用私有权限。项目级锁防止并发切换。

旧目录移到私有 `backups/cli-cutover-*/retired`，原工作区路径消失，备份保留到人工确认可清理。`~/.pi/dashboard/res-workflow`、原始会话/附件/权限等身份根继续使用原绝对路径。sealed adoption 文件的 inode 和时间戳不会被重写。

失败时先停止新 writers，再还原已验证的原文件和链接。若新运行数据或用户配置已有变化，事务保持两套调度器停止，journal 标记 `rollback-needs-reconciliation`，保留数据供人工合并。进程崩溃遗留锁只允许匹配同一 journal、且原 PID 已退出的显式 rollback 接管；不自动恢复旧调度器。

实际执行前还需机器上的 proof 回调确认：旧原生 RPC/keeper/CLI writer 全部静止；新宿主能读取原会话和 sealed history；研究、自动化、goals/KB、事件 replay、MCP/CLI 等保留功能产生预期可核查结果；host 重启可恢复；新 proxy 的 TLS/Basic Auth、WS ticket、private route 拒绝及 workbench-sync 均正常。合成测试验证事务行为，实际业务证明由这些回调记录。
