# 可追溯技能源码

这是技能的**源文件**快照，不是node_modules或私人研究目录。

- `aris/`：已安装的69个公开逐字匹配技能 + 14个本机衍生技能，另含shared references。原MIT许可保存在`aris/LICENSE`和`vendor/licenses/aris.MIT.txt`。
- `licensed/`：5个随附MIT/Apache许可证的技能，保留源脚本和引用，不保存宣传图／生成截图。
- `tools/`、`templates/`：技能引用的固定公开ARIS辅助文件，不会自动运行watchdog或安装hook。
- `config/skill-provenance.json`：每文件SHA256、公开revision／本机副本来源、108个技能的覆盖状态。

`docs/REPRODUCTION.md`说明安装、发现、canonical路径及缺工具停止规则。这里的第三方技能保留原作者和许可，不由仓库根Apache重新授权。某些上游文档列出自己选择的模型/MCP工具；它们不代表本仓库提供认证或授权，也不替代Pi当前工具可用性检查。

IEEEtran `.cls`／`.bst`拥有独立LPPL-1.3许可，未复制进源树，不随ARIS重新标MIT。使用IEEE模板前从自己的TeX发行版或完整CTAN上游取得，来源hash列在manifest的externalLicensedDependencies。

HTML/PDF等技能的README可能引用未收录的上游宣传图片；这些是文档资产，不是执行依赖。文本源完整性与实际外部服务运行验收应分别记录。
