# 二次开发

## 仓库结构

```text
integration/              自有证据工具、route/gate、workflow与离线测试
agents/                   科研角色；默认继承本机实际模型
extensions/               最后一条消息撤回；可选绘图扩展
config/                   无凭据模板与版本来源/hash
bin/                      可移植的 Pi/dashboard/browser 启动入口
scripts/                  安装、上游补丁、发布检查；无自动运行环境重启
patches/                  已部署dashboard/subagents源码差异
vendor/skills/            许可明确的技能与辅助源码、逐文件provenance
vendor/licenses/          被引用上游的原许可证
docs/images/              脱敏真实截图与已标注概念插画
```

## 最小开发循环

```bash
npm test
npm run check:syntax
npm run check:release
```

集成层是原生 ESM，不需要为了改一个 route 去搭新 harness。
`integration/workflows/*.js` 是 Pi workflow 的顶层 statement body，不是直接
`node xxx.js` 执行的程序；使用 Pi 的 subagent workflow API，读取当前安装版本文档。

改动遵循：明确一个目标 → 小测试 → 最小修复 → 保存原始输出。后台启动成功不等于结果通过；模型名称不等于可信执行身份。需要跨模型 review 时必须有用户授权，独立上下文与证据来源，不能无止尽自动审查。

## Dashboard 定制

上游是 MIT 项目，本仓库不是完整 fork。三个补丁只能应用到固定提交：

1. `0001-deployed-frontend.patch`：当前部署的前端源差异，包含撤回按钮、输入回填、pending保护及此前native子任务/布局定制。
2. `0002-deployed-native-bridge.patch`：**正在运行的**native子任务bridge改动。
3. `0003-deployed-runtime-config.patch`：9个已安装server/shared源码差异；shared reader取真正被加载的单独shared包版本。包括隔离agent配置路径、defaultmodel/thinking写回、context-window投影与managed npm资源扫描。

`node scripts/verify-dashboard.mjs /path/to/patched-checkout` 会逐文件核对
发布快照29个源hash。补丁**不含**暂停的 B1/R4历史重放事务、超时tail等未验收后端。

执行 `scripts/prepare-dashboard.sh` 只准备源码与构建，运行/重启仍由开发者决定。
如果未来升级上游，先重建补丁并做契约验证，不用 `git apply --reject` 后忽略失败。

## 子代理、依赖与技能快照

`apply-subagents-patch.mjs`限定pi-subagents0.76.1和原始／目标SHA256，拒绝未知内容，幂等检查后再应用。不要为兼容升级而删掉hash保护。依赖锁保存直接及传递包版本／integrity，不收录node_modules；npm ci遇到非空未知安装目录会停止。

技能保留原许可证和来源状态。修改vendor文件须同步明确`config/skill-provenance.json`新hash及本地改动原因，不能保留旧hash谎称原文。显式install-skills拒绝已有目录；默认不执行源内脚本、hook或外部reviewer。若需恢复20个未知来源技能，先补足来源／许可，而不是把私有目录整树上传。

## 添加模型/服务

示例配置不绑定作者账号。用自己的 `/login` 和 registry 选择真实可用模型，或配置环境变量。所有真实 auth、cookies、SSH host、provider配置必须留在 `.runtime/` 或独立 agent 目录之外的忽略路径，不写入 tracked 文件。

默认模型 thinking 为 max；external CLI 角色按自身runner合同，不能伪造native thinking 支持。内存较小的机器要降低并发，而不是把heap上限当作aggregate RSS保证。

## 发布

1. 只发布白名单资产；不提交 `.runtime`、日志、论文数据、auth、session。
2. 新截图只在独立浏览器中脱敏，目视核验，不改变真实会话。
3. 记录可复现的上游提交、依赖版本、已部署源码hash和明确未验证条件。
4. 执行离线门禁与敏感信息检查，再commit/tag/push。

仓库初始为私有。公开前复核许可证和数据授权；私有仓库也不是存储凭据的地方。
