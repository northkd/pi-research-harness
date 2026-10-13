# 可复刻内容：这次补齐了什么

本页把“可上传但之前遗漏的代码”与“必须由新设备自行准备的状态”分开。**源码完整性、安装成功和科研／模型能力验收是三件事。** 本仓库不复制私人数据，但不再以隐私为由遗漏普通可发布源码。

## 已补齐的源码和配置

| 前轮缺口 | 当前保存方式 | 新设备操作 |
|---|---|---|
| 9 个额外 dashboard server/shared 源文件 | 第三个 MIT 补丁 `0003-deployed-runtime-config.patch`；实际加载 shared reader 的 context-window 解析也已包含 | `prepare-dashboard.sh`按顺序应用3补丁，核对共29文件hash，再构建 |
| 子代理嵌套 async 身份修正 | `patches/subagents/`、包版本和前后hash、MIT许可证 | 核心安装后自动应用；未知版本或未知源码拒绝修改；check-only可验证 |
| 四个 dashboard plugin bridge | 可移植源路径和opt-in配置，不复制dirty树；这4个bridge与固定上游源码一致 | 新配置加`--with-dashboard-plugins`，或自行合并模板；不会自动启动服务 |
| KB 与服务 | 项目KB模板、plugin/engine位置、systemd和loopback Caddy模板 | 设置自己的知识源并Index now；启动端口与远程授权由本人决定 |
| compaction、非模型 thinking 覆盖 | settings模板已对齐reserveTokens/keepRecentTokens与角色thinking | 新配置自动取得；不包含作者真实provider/model默认值 |
| 路由／历史工具实现 | `integration/model-routing/`两个实现、默认禁用的policy模板、synthetic测试 | 明确填入自己的授权池；不是自动后台评测服务，不恢复真实验收历史 |
| 传递依赖漂移 | Pi、13扩展和browser MCP三组npm lock | 使用`npm ci`与逐项manifest校验；版本锁不等于外部CLI或OS环境锁 |
| 外部技能 | `vendor/skills/`实际源码、辅助文件和许可证；每文件SHA256、来源状态 | 显式启用或安装canonical目录，见下节 |

第三个dashboard补丁保存当前实际使用的provider/config/context/scanner修改，不包含账号或key。补丁不对这些历史修改追加新功能或声称每项已在全新构建下重新验收。暂停的B1/R4历史重放候选仍不在仓库。

## 技能不是只有清单

本机108个可执行SKILL.md（另有shared-references目录）中，已保存 **88 个技能**：

- 69个ARIS主文件与固定公开Git blob完全一致，相关辅助文件也核对来源。
- 14个本机ARIS衍生版本保留实际文本；与固定上游的差异已核对，原安装revision未知，不能冒称逐字上游版。
- 5个独立技能（pdf、playwright、skill-creator、html-ppt、mineru）带原MIT/Apache许可证；源码版不含上游宣传图、生成截图、pycache或第三方依赖目录。
- 来源记录是`config/skill-provenance.json`；ARIS基线固定为`26b95cfa0d8747078e9e43b42e20952709e561b8`，保留原MIT许可。最终401个技能／辅助源码文件逐项记录。
- 两个IEEEtran `.cls`／`.bst`文件自带独立LPPL-1.3声明，不属于ARIS MIT范围；发布版不复制它们，由TeX发行版或[完整IEEEtran上游](https://ctan.org/pkg/ieeetran)提供。主文件hash／来源及实际许可在`externalLicensedDependencies`保留，IEEE模板使用前用`kpsewhich IEEEtran.cls`／`kpsewhich IEEEtran.bst`确认，不声称捆绑目录含它们。

剩下20个技能的来源或许可还不能证实。它们的名称及本机SKILL.md SHA256已列入同一清单，**不是已安装／已上传的技能**。不擅自将这些文件重新标为作者原创，也不上传论文筛选项目专用内容。

### 使用捆绑技能

轻量查看：源码已经在仓库里，两个Feynman↔ARIS入口直接指向捆绑canonical文件，不再必须依赖作者机器上的`~/.agents`。

如果只需Pi发现已捆绑技能，在创建全新agent目录时用：

```bash
PI_RESEARCH_AGENT_DIR=/absolute/path/to/new-agent \
  node scripts/configure.mjs --with-bundled-skills --dry-run
```

去掉dry-run会创建新目录，拒绝覆盖现有配置。也可以手工合并生成的skills路径；不要对已安装配置直接重跑configure。

某些上游helper通过`~/.agents/skills`寻找canonical目录。新设备该目录为空时，可显式复制并逐文件校验：

```bash
node scripts/install-skills.mjs --dry-run
node scripts/install-skills.mjs
```

默认目标为本人的`~/.agents/skills`，拒绝非空目录及symlink，不覆盖已有技能。也可传入绝对目录作离线复制验证，但上游写死的`~/.agents`引用仍需由本人重定位。

少数training/meta技能以`../../tools`或`../../templates`引用上游根目录。捆绑vendor布局保留这些位置；canonical复制把辅助源放在目标内的`tools/`／`templates/`，**不会越过目标目录安装hook或写`~/.agents/tools`**。使用这些少数helper时应优先从vendor原树执行或本人显式重定位，不能将canonical复制成功说成所有辅助工具可用。

**技能文本不会凭空注册Codex/Oracle/llm-chat MCP。** 现有Pi入口仍要求实际后端、材料外发授权、身份与证据可验证；缺少工具时停止，不静默切换。选择安装源码不等于允许上游技能的所有自动流程执行。项目／用户权限仍优先。

## 完整配置与服务

可选的完整新安装入口（dry-run不下载、不写文件）：

```bash
PI_RESEARCH_AGENT_DIR=/absolute/path/to/new-agent \
  bash scripts/install.sh --with-dashboard-plugins --with-browser --with-bundled-skills --dry-run
```

去掉dry-run会安装锁定依赖并创建新配置；dashboard源码／browser MCP仍分别准备，不自动启动服务。只需要生成新配置而不安装时可直接使用`node scripts/configure.mjs`及相同flags。

四bridge分别是automation、flows、goal、flows-anthropic-bridge；**KB不是第五个session bridge**。KB在独立server-plugin/engine中，project配置路径是`.pi/dashboard/knowledge_base.json`。模板只索引相对`docs`，不会自动把全部研究、PDF或聊天塞进知识库，也不自动执行index。

服务模板不含作者用户名、服务器IP、密码或浏览器profile。Chrome网页登录、SSH别名/密钥、Slurm资源与环境、agy登录、TeX安装、HTTPS策略均需本地设置。`config/external-tools.example.json`记录需求，不宣称执行安装或调用已获授权。

## 仍不能靠Git恢复的内容

- 模型账号、真实provider映射／额度及调用历史，浏览器cookie/profile、远程凭据。
- 私人会话、长期记忆、KB索引、论文、输入和原始计算结果。续接研究时用独立加密迁移及hash核对。
- 本机专用且许可未证实的20个技能。
- 新设备CPU/OS/系统工具、网页实际模型、远程计算资源差异。

因此现在的目标是**可复刻当前已保存的软件源码和配置机制**，而不是把私有整机镜像放进Git。是否完整安装、插件加载、fresh dashboard build和认证工作流可用，仍需看[验证记录](VALIDATION.md)，不能由文件数量推导。
