# README 配图、来源与重绘

更新日期：2026-11-05。源码核对基线：`b79930abc23c7f5a93bc61e83979b25a5219bdea`。

当前 README 使用两类图片：**依据实际实现绘制的流程图**，以及**真实构建的界面截图**。流程图说明代码关系，界面截图使用明确标注的合成演示数据；两者都不作为真实研究结果或外部服务验收的证据。

## 三张源码流程图

| 图 | 内容 | PNG 原始尺寸 | 可编辑矢量 |
|---|---|---|---|
| [project-illustration.png](project-illustration.png) | 入口、Pi 会话与委派、研究记录、观测回流、独立 Science 查看通道 | 3840 × 3200 | [project-illustration.svg](project-illustration.svg) |
| [research-capabilities-dark.png](research-capabilities-dark.png) | `auto-research` 实际 Stage 1–3、提前返回、多轮评审与另行接续的 Stage 4/5 | 3840 × 3700 | [research-capabilities-dark.svg](research-capabilities-dark.svg) |
| [evidence-review-loop.png](evidence-review-loop.png) | 尝试与主张、评审契约、主张验收字段、人工发表授权、旁路主线监督 | 3840 × 3860 | [evidence-review-loop.svg](evidence-review-loop.svg) |

图中全部文字、位置、连线和箭头由[绘图脚本](../../scripts/render-readme-diagrams.py)显式定义，用 Matplotlib 绘制。没有使用生成式图像补造科研流程、结果曲线或产品界面。PNG 以 3840 像素宽直接导出，未从小图插值放大；SVG 保留文字元素，编辑时需要相应中文字体。

每个节点和箭头的实现依据、条件与不能推导出的保证见 [workflow-source-map.md](workflow-source-map.md)。图中特别区分：

- 真正的任务调用、返回，以及已有状态的读取与观测。
- 独立顶层 Pi 会话与属于父会话的 Subagent。
- `auto-research` 的前三阶段与主会话另行组织的总结、写作。
- `converged`、评审契约通过、主张验收和用户发表授权。
- Science 的独立查看接入与已有任务跟随，不画 Pi 自动提交 Science 任务的关系。

原来同名的两张生成式概念插画已被这次源码流程图替换，旧版本及其生成说明保留在 Git 历史；旧版模型名称、提示词、尺寸与校验值不适用于当前文件。

## 重新生成

需要 Python 3.10+、Matplotlib、Pillow 和 Noto Sans CJK 中文字体。它们仅供文档绘图，不是 Pi 或 Dashboard 运行依赖。

在已有上述依赖的环境中，从仓库根目录运行：

```bash
python3 scripts/render-readme-diagrams.py
```

脚本默认把三组 SVG/PNG 写入 `docs/images/`。字体自动搜索常见 Noto 安装位置；也可以显式指定：

```bash
python3 scripts/render-readme-diagrams.py \
  --font /absolute/path/to/NotoSansCJKsc-Regular.otf \
  --output-dir /absolute/path/to/diagram-output
```

`README_DIAGRAM_FONT` 环境变量也可指定字体。脚本包含文字边界、导出尺寸和单文件大小检查；文字使用源画布至少 26 像素的字号，PNG 每个文件小于 5 MiB。发布前仍需在 README 实际显示宽度下目视核对文字与箭头。

绘图后若要更新内容，应同时修改脚本、图片与源码对应表。不要只改 PNG 中的文字而留下与源码不一致的箭头或说明。不同字体、Matplotlib 版本可能影响排版，重绘后需重新检查。

## 当前界面截图

下面的文件来自 `docs/ui-redesign/screenshots/`，保留 UI 改版时的原始截图。测试启动真实 Dashboard 生产构建，沿用原生认证，使用独立临时用户目录和明确标注的合成项目；复杂协作画布使用项目已有演示模拟器。

| 页面 | 原始截图 |
|---|---|
| 研究工作台 | [01-real-workbench-1440.png](../ui-redesign/screenshots/01-real-workbench-1440.png) |
| 智能体协作模拟 | [06-agents-demo-1440.png](../ui-redesign/screenshots/06-agents-demo-1440.png) |
| 已结束的演示对话 | [10-session-chat-1440.png](../ui-redesign/screenshots/10-session-chat-1440.png) |
| 费用详情 | [11-usage-drawer-1440.png](../ui-redesign/screenshots/11-usage-drawer-1440.png) |
| 文件 | [03-files-1440.png](../ui-redesign/screenshots/03-files-1440.png) |
| Science 未连接时的入口 | [04-science-1440.png](../ui-redesign/screenshots/04-science-1440.png) |
| 深色主题 | [09-workbench-dark-1440.png](../ui-redesign/screenshots/09-workbench-dark-1440.png) |
| 手机宽度 | [08-workbench-light-360.png](../ui-redesign/screenshots/08-workbench-light-360.png) |

它们证明相应界面在合成数据环境中完成了渲染和定向交互检查，不证明真实模型调用、活跃 bridge、远程计算或 Science 后端已经运行。此次文档重写复用这些既有截图，并重新绘制源码流程图，没有冒充重新拍摄了一次真实科研执行。

截图的环境、操作与验证边界见 [UI 实施与验证](../ui-redesign/implementation.md)、[浏览器报告](../ui-redesign/browser-report.json) 和 [隔离检查启动器](../../scripts/ui-preview/README.md)。

## 保留的历史截图

以下文件采集于 2026-10-12，保留供历史文档引用，当前 README 不再把它们作为新版界面示例：

- [dashboard-redacted.png](dashboard-redacted.png)：旧版真实 Dashboard，通过不透明遮罩覆盖私人会话和账号内容；只展示当时布局，没有执行真实研究任务。
- [undo-edit-redacted.png](undo-edit-redacted.png)：旧版“撤销并编辑”按钮局部截图；采集时按钮处于禁用状态，没有点击，不能用作完整撤销/重发操作的验收证据。
