> 这是本次开发前的设计基线，保留原始核查范围和设计要求。已完成实现与实测结果见 [实施与验证](implementation.md) 和 [功能保全审计](feature-preservation.md)。

# Pi Research Harness UI 改版完整意见与实施验收说明

版本：1.0
日期：2026-11-05（北京时间）
对象：northkd/pi-research-harness
代码基线：main，af2810437b39772db62201b9f86346cdb9d62dfc
交付目的：在保留现有功能、数据与操作语义的前提下，重排界面信息层级，形成可供开发者或本地 AI 直接执行的方案。

## 0. 阅读结论与核查范围

推荐采用“项目与会话导航＋主工作区＋可收起的任务概览”，并将主工作区划分为“对话／研究工作台／智能体／文件／Science”。自动化、Goals、Flows、知识库、MCP、OpenSpec 与其他插件保留在项目工具和插件入口中；终端、普通浏览器与运行日志保留为可展开的工具区。

本轮新效果图展示“研究工作台”状态；上一版对话效果图对应同一套导航下的“对话”状态。两张图是同一产品的不同视图。效果图中的任务、金额和文件状态均为排版示例，不能作为真实科研结果或验收依据。最终实现应以本文的功能清单、状态定义及交互要求为准，图中装饰与小图标不得覆盖这些要求。

本方案依据三张用户截图，以及指定提交的 README、0.20 发布文档、源码覆盖层、插件注册、部分测试与构建脚本编写。已核查代码结构和关键操作路径，未启动实际 Dashboard、未执行模型任务、未验证用户服务器上的部署。本次交付为设计与实施说明，未修改仓库业务代码。

### 0.1 当前仓库的重要事实

1. 当前主线是 0.20 开发基线，Dashboard 上游固定为 v0.10.0，提交为 65dc4558c7b07ef755ee4f0eda89d9f63e7e76e0。
2. 定制源码的主要入口是 patches/dashboard-v0.20/overlay/；config/dashboard-v020.json 在本次基线中登记 581 个覆盖层文件。
3. 该仓库保存固定上游之上的定制层，不是独立重写的完整前端。原上游能力、注册插件及运行时额外定制也在功能保留范围内。
4. docs/DEVELOPMENT.md 中部分内容明确属于旧快照；本轮应以 docs/RELEASE-0.20.md、当前覆盖层及实际脚本为准。
5. 仓库文档明确提示：Git 检出与服务器实际运行目录可能不同，仅 git pull 不会更新正在运行的 Dashboard。因此“保留全部功能”需要同时对照仓库基线和实际部署增量。[S01][S02]

### 0.2 改版完成的定义

必须同时满足以下四项：

- 旧功能均有明确的新入口，并沿用相同操作结果、数据来源、身份范围及已有权限条件。
- 日常阅读明显清晰，研究工作台、智能体图和文件编辑可独立获得足够空间。
- 切换视图、分屏、抽屉及项目时，草稿、运行任务和文件状态保持正确，不串会话、不误停任务。
- 有功能迁移表、关键行为回归结果及同场景截图；不能仅以“页面能打开”或“效果图相似”作为完成标准。

## 1. 总体设计约束

### 1.1 功能保留原则

- 允许移动、合并展示、折叠和分页；不删除原有操作及其对应数据。
- “收进菜单”必须给出明确名称和可发现入口，不能用大量无标签图标替代原功能。
- 高频功能保持直接可见；低频功能可进入一个有名称的菜单或详情页。
- 复用现有组件、事件处理器、状态管理、插件挂载点和 API。视觉改版不另造一套运行控制器、账单计算器或科研状态源。
- 对源码中已经存在的误导性文案和状态映射，修正呈现含义，同时保留真正有效的操作能力。
- 未配置、不可用、断线、覆盖不完整和未记录状态继续存在，不能为了界面整齐统一显示“正常”或“0”。
- 保留现有深色／浅色、语言和显示偏好；新浅色风格是推荐视觉方向，不能成为删除其他主题的理由。
- 不新增与本次排版无关的授权流程；已有操作条件、用户偏好和必要的确认语义保持一致。

### 1.2 实施前建立功能基线

建议创建一份功能迁移台账，每条记录包含：

功能 ID、所属范围、旧入口、旧组件或插件、触发行为、调用方式、状态与禁用条件、新入口、回归用例、验收结果。

基线至少包括：

- 当前 Git 提交、上游固定提交、运行构建标识。
- 当前服务器启用的插件与额外前端定制。
- 已注册的路由、会话菜单项、命令入口、编辑器伪标签与插件槽位。
- 会话、目录、文件、终端、Science、预算、计费与科研工作台中的操作。
- 旧版浏览器深链接、返回行为及常用快捷键。
- 设置中已启用的主题、密度、思考区、动画、消息显示及其他显示选项。

“仅出现在实际部署中的功能”单列，先找到对应源码或接入方式，再交付替换版本。不得直接用当前 main 构建覆盖未知运行版本，随后才发现某个插件消失。

## 2. 信息架构与导航

### 2.1 全局区域

| 区域 | 默认职责 | 可见内容 | 展开后的能力 |
| --- | --- | --- | --- |
| 全局顶栏 | 确认项目、连接和资源概况 | Pi Research、项目面包屑、连接状态、明确口径的费用入口 | 服务器／连接详情、费用与性能、设置 |
| 左侧导航 | 找项目与会话 | 项目选择、搜索、新建、最近／活动会话 | 全部会话、归档、多目录、工作树、项目工具 |
| 主工作区 | 完成当前任务 | 当前选中视图 | 大对话、大画布、编辑器、科研表单 |
| 右侧任务概览 | 提示当前上下文与阻塞项 | 当前交互会话、待处理、监督摘要、用量入口、同步状态 | 选中 Agent／事件／预算／费用的详情，可最大化 |
| 底部工具区 | 保留执行和查看工具 | 终端、普通浏览器、运行日志入口 | 原有工具完整视图 |

不要让“研究工作台”继续藏在“文件”面板内部，并在外层重复出现一套编辑器标签和控制条。现有 research: 伪标签及旧路由仍应兼容，导航到新的对应视图。[S03][S04]

### 2.2 五个主视图

| 主视图 | 主要内容 | 重要保留项 |
| --- | --- | --- |
| 对话 | 用户消息、主智能体答复、工具调用、关联产物 | 输入、队列、停止、回后台、撤销并编辑、历史定位、模型与思考级别、扩展消息与工具渲染 |
| 研究工作台 | 课题目标、五阶段、预算、主张、审计和资料接入 | 当前实际记录与查看阶段分别显示，接续与新建动作保持原义 |
| 智能体 | 独立协同会话、Subagent、工作流记录、角色与执行详情 | 画布、列表、角色矩阵、筛选、轮次、来源、真实父子关系 |
| 文件 | 文件树、标签、编辑、预览、差异和插件文件处理 | 未保存编辑、打开标签、深链接、伪标签、资源查看、二进制提醒 |
| Science | 原生页面、实例、详情、产物 | 输入开关、适应／1:1、重连、预览下载、实例状态与隔离 |

五个视图共享明确的项目范围，但不强制都依赖当前选中的 Pi 会话。尤其 Science 和目录文件工作区应继续支持在没有 Pi 会话时打开。

### 2.3 研究工作台的二级导航

现有 ResearchPipelinePage 定义了六个页签。改版后映射如下：

| 现有页签 | 新位置 |
| --- | --- |
| Agent 协作网络 | 顶级“智能体”；研究工作台提供直达链接 |
| 工作流进度 | 研究工作台 → 工作流进度 |
| 总览与预算 | 研究工作台 → 总览与预算 |
| 主张与评审 | 研究工作台 → 主张与评审 |
| 历史与审计 | 研究工作台 → 历史与审计 |
| 全部看板 | 研究工作台 → 全部看板 |

“全部看板”是保留给需要同时检查多个区块的用户的完整视图，不能被删除。可以允许用户固定为默认页，但日常默认不强制把所有区块全部展开。[S03]

“资料接入与项目设置”放在研究工作台标题行，直接进入专用页面或宽抽屉。未接入项目仍显示引导；已接入项目显示简短状态和入口，避免接入表单长期占据工作流正文。

### 2.4 项目工具与扩展

左侧项目工具优先显示自动化、Goals、Flows、知识库、MCP、OpenSpec，其他能力通过“更多项目工具”及“插件管理”进入。

这几个显示名称不是功能白名单。必须从现有插件机制保留其余注册入口、设置、命令、工具渲染和后台订阅。当前生成的插件注册中还包含角色、技能图谱、记忆、团队、浏览器、网页访问、多类文件处理与其他集成；是否启用以实际配置为准。[S05]

## 3. 布局、视觉与响应式规格

以下数值是实施起点，应以真实组件和截图检查调整。

| 项目 | 推荐规格 |
| --- | --- |
| 全局顶栏 | 高度约 52–56 px |
| 主导航 | 高度约 44–48 px |
| 桌面左栏 | 默认 232–248 px，可调整和收起 |
| 右侧概览 | 默认 300–340 px，可关闭／展开为详情 |
| 对话阅读区 | 最大正文宽度约 760–900 px，按实际字体调整 |
| 常规正文 | 14–16 px；科研长文可提供更大字号偏好 |
| 页面标题 | 20–24 px；不使用占半屏的大标题 |
| 常规间距 | 8／12／16／24 px |
| 列表行 | 紧凑模式约 44–56 px，长标题允许两行 |
| 主要操作 | 单一蓝色强调；错误、等待和选择使用明确的语义样式 |

### 3.1 分辨率行为

| 可用宽度 | 推荐表现 |
| --- | --- |
| 1440 px 及以上 | 左导航＋主区＋可收起右概览 |
| 1100–1439 px | 缩窄左栏，右概览默认改为抽屉；用户仍可手动分屏 |
| 768–1099 px | 导航可收起，正文优先，详情覆盖或全页显示 |
| 360–767 px | 单主区、抽屉导航、全屏详情；输入和关键操作保持可用 |

不能因为宽度变小，就隐藏某功能且不给替代入口。代码、表格和图画布允许局部滚动；整个页面不应被长路径、模型名称或表格撑出横向滚动。

### 3.2 层级和颜色

- 白色或主题主表面用于正文，浅灰用于导航与辅助区。
- 首先用标题、间距、对齐和分隔线建立层级，再少量使用边框与色块。
- 活跃／选中使用蓝色；等待、覆盖不完整使用橙色提示；错误或真实停止操作使用红色。
- “已结束”仅表示生命周期结束时，使用中性样式；只有已知成功完成的执行才使用完成样式。
- “已进入阶段”“执行成功”“科学支持状态”“发表许可”分别表达。
- 所有状态均有文字或可访问名称，不只靠颜色和动画。
- 保留现有主题 token；新增语义 token 时同时处理浅色和深色，避免写大量全局固定颜色或 !important 规则。
- 保留减少动画偏好。取消与工作状态无关的大面积呼吸、渐变边框与不断闪动背景。

### 3.3 滚动与状态保持

主区、左侧会话列表及必要的详情区可以独立滚动，但避免卡片内部再嵌套多个滚动层。切换页签时保存合理的滚动位置、搜索条件、拓扑视口和输入草稿。

用户主动收起某个正在更新的区块后，应保持收起，并通过小型新活动提示通知；不要每次轮询就撑开卡片。

## 4. 分模块修改意见

### 4.1 项目与会话导航

将 SessionCard 的常驻内容收敛为标题、一个明确的会话状态及必要的时间／未读提示。使用柔和选中底色和细标记，替代彩色渐变粗边框。

必须保留：

- 新增文件夹、工作区、目录切换与目录设置。
- 多目录视图、搜索、过滤、归档、批量入口和已结束会话访问。
- 会话重命名、恢复、派生／Fork、归档、关闭以及现有上下文菜单。
- 普通新建、带工作树的新建、加入科研工作台与普通会话的选择。
- 工作树与 OpenSpec 的相关操作，继续按原有可用条件显示。
- 会话来源、成员关系、插件徽章和必要的待处理提示。
- 长标题和长路径的完整查看／复制途径。
- 目录费用原有范围说明；不能按搜索结果中的可见行重新统计。

会话主要状态应与运行进程状态分开。例如“会话有待处理事项”与“进程 idle”可以同时为真，但不能在两处显示两个没有解释的主要状态。

### 4.2 对话与输入

保留 ChatView 和输入事件通路，优先改变包裹结构与显示密度。

推荐顺序：用户问题 → 阶段性答复／结果 → 文件或证据 → 执行记录 → 下一次输入。

运行日志处理：

- 优先复用现有 ToolBurstGroup、ToolCallStep、ThinkingBlock 与 ChatViewMenu。
- 普通连续工具事件默认合并为可展开的一轮执行记录。
- 工具详情、原始输出、错误、时间、复制和专用插件渲染仍可访问。
- 失败、授权阻塞、需要用户回答的交互直接露出，不被普通折叠规则吞掉。
- 分组只改变展示，不删持久事件，不重新生成或改写原始消息。
- 保留现有完整展开／收起、长文本换行、代码缩进、宽表局部滚动与复制全文语义。
- 流式更新中不抢走用户正在选择的文本，不强制滚回底部；保留返回最新内容入口。

输入区保留：附件、命令、Shell、模型、provider、思考级别、发送方式、队列／steering、停止、回后台及现有插件 composer 内容。

“撤销并编辑”继续沿用已有边界：只处理当前会话最后一条可安全处理的用户消息，运行时遵循原保护，回填后由用户自行重发；不宣称撤销已经执行的文件或外部操作。[S06]

### 4.3 研究工作台与五阶段

使用源码中的实际阶段名称：

1. 调研与发散。
2. 实验与验证。
3. 对抗评审。
4. 结论核对。
5. 论文与审计。

阶段条是“浏览／筛选入口”。必须同时区分“当前正式记录阶段”和“用户正在查看的阶段”。点击阶段不更改研究状态，不自动启动模型；“此前进入”也不表示该阶段已经通过。[S07]

工作流进度页保留：

- 冻结研究目标、当前阶段、控制环 phase、真实 run 与步骤。
- 未登记阶段的执行记录。
- 每阶段独立新建会话，含首条 Prompt 编辑、模板恢复、取消及确认。
- 接续研究与新工作流的不同说明／指令。
- 关联角色、具体执行记录、产物及来源。
- 缺记录、错误、上次数据、覆盖不完整和同步时间。

“新建本阶段会话”应如实说明创建新会话；不能把它命名为恢复原任务。“查看阶段”与“启动阶段会话”使用不同控件，防止浏览动作变成执行动作。

### 4.4 智能体协作

智能体主区获得完整画布宽度。顶部只保留一条清楚的工具栏，包含搜索、视图、筛选和布局操作。

保留三个查看方向：

- 画布：全局会话关系、聚焦会话及其子任务、返回全局。
- 列表：按运行／等待／失败／结束等条件定位执行。
- 角色矩阵：配置角色、模型、技能、跨会话执行归属与历史轮次。

需要分别标注三类执行来源：

| 类型 | 展示名称 | 不应混淆的内容 |
| --- | --- | --- |
| pi-session | 独立协同会话 | 不是全部都属于某个会话的 Subagent |
| native-subagent | 原生子代理任务 | 具有真实父执行／运行标识 |
| workflow-step | 工作流文件记录 | 不冒充已观测到的原生任务 |

用户创建、工作流创建、Lead 创建的来源保持一致，依据持久 provenance；不根据标题、模型或最近活跃时间推断身份。工作区分组线与有证据的 dispatch／handoff 关系使用不同图例。仅在数据支持时画通信或派发关系。[S08]

画布完整交互保留搜索、拖动、缩放、Ctrl／⌘＋滚轮、适应画布、聚焦／返回、角色分页、轮次展开及键盘操作；实时状态更新不重置用户的平移缩放位置。

详情面板至少保留 Prompt、输出、最近输出、错误、模型、ID、阶段、时间、父子来源、技能／工具、历史实例、证据文件及完整对话跳转。

### 4.5 监督与纠偏

Agent 详情中的监督输入保持可用，但必须显示目标对象、投递状态和失败原因。

- 有真实会话目标时复用现有发送行为。
- 无可投递目标时显示“不可直接投递”或明确的本地备注状态，不能生成“已下达”回执。
- 若将文本交给父会话，必须显示真实接收者，不能声称直接送达子任务。
- 快捷纠偏是文本模板，应能查看、编辑；停止任务使用原有真正停止控件。
- 特定项目的 AIMD 温度等条件不应成为所有课题的固定提示，改为项目模板或发送前可编辑内容。
- “当前交互会话”与真实调度主控分开。前端选择一个会话仅改变查看／交互入口时，按钮就按这个含义命名。

### 4.6 主张、证据与评审

建议将当前分散的主张信息整理为一行一主张，展开后同时查看：

- statement、主张状态、条件／边界与证据。
- 验收 verdict。
- 评审模型和模型族。
- 反例状态、诊断、未决义务。
- 发表授权及其范围。
- 关联原始文件、执行记录和来源。

流程评审轮次／review-gate 与逐条主张验收保持两个层次。代码测试通过、工作流完成、文件已生成都不能自动把主张改为 supported。

状态名称应来自真实数据，缺字段显示未记录；不能用绿色图标替代具体验收含义。保留历史记录与查看全部入口。[S09]

### 4.7 资料接入、历史复核与成员关系

这是已有功能，建议收纳为专门的“资料接入与项目设置”，不能因为默认主界面简洁而删除。

完整流程保留：

1. 当前目录、补充扫描、仅使用目录文件、历史来源选择。
2. 来源与跳过项、覆盖范围、精确 provider／model。
3. 本地准备、计划、预算与已有授权步骤。
4. 阅读／分析进度、检查点、失败与恢复。
5. 接入草案、来源证据、未定问题。
6. 目标与成功标准的编辑边界，保留已有冻结目标。
7. 确认接入、取消、成员关联及关联失败重试。

现有完整历史复核 v1 和接入 agent v2 的恢复规则不同，页面按真实协议分别呈现，不把它们包装成一个含义不清的“继续”按钮。

加入工作台只建立成员关系；确认接入草案也不能自动启动 Stage 1、验收研究结论或授权发表。覆盖未完成或实际授权不匹配时，原有确认条件继续生效。[S10]

### 4.8 预算与用量

“总览与预算”分成研究预算、观测用量及明确的接入任务预算链接。

| 指标 | 单位／范围 | 呈现要求 |
| --- | --- | --- |
| 研究尝试上限 | 次 | 显示上限、已用、剩余、是否接管 |
| 受控模型请求 | 请求次 | 显示在途、未知、限制与执行通道 |
| 接入任务预算 | 单次接入任务物理请求 | 独立展示初次／补充授权与恢复规则 |
| 已观测响应／token | 已保存观测的下界 | 标明覆盖、继承历史排除与陈旧状态 |
| 账单等价费用 | 明确月份／范围的货币值 | 跳转费用详情，不与次数混算 |

观测响应可能与受控请求重叠，不能直接相加。0、未配置、无限制、未知分别显示。

编辑预算保留草稿、保存、冲突重载与丢弃机制。保存预算不启动研究、不清零、不取消在途请求；接入预算调整不自动继续、不延长原授权到期。[S11]

### 4.9 费用、性能与历史月报

顶部只保留一个紧凑入口，详情中继续保留“费用／性能”两组完整能力。

费用详情：

- 主 Agent 与 Subagents 分账。
- 输入、输出／思考、缓存读／写、按次费用和缓存节省。
- provider／model、费率单位、调用数。
- 逐轮明细及全部／主 Agent／Subagent 筛选。
- 未定价、不完整和无法读取状态。

性能详情：

- TPS、加权均速、生成耗时、响应耗时。
- 正文／思考 token、缓存命中、主／子模型与速度历史。
- 合理的表格滚动、筛选和尺寸记忆。

历史月报继续保留月份、目录、会话、模型维度、模型排序、本月与刷新。

必须维持三个口径：

1. 会话金额：北京时间本月会话及子任务的人民币等价消耗，不是生命周期累计或供应商实际扣款。
2. 目录金额：当前源码明确为“已载入会话本月小计”，不能改名为全目录全部历史总账。
3. 未定价：继续显示待定价、≥已定价小计及不完整计数，不能显示成确定的零。

复用现有共享 snapshot／poller 和去重逻辑；不在新的顶部、侧栏和抽屉分别重算费用。[S12][S13]

### 4.10 文件、编辑器、终端和普通浏览器

文件主视图保留现有 EditorPane、EditorTabs、viewer registry、file handler 与伪标签机制。迁移顶层导航时，不把所有内容统一当作普通文本文件读。

必须保持：

- 文件打开／关闭、切换、编辑、保存、未保存提示。
- 文件树、文件定位、行号深链接、差异查看和现有预览。
- 图片、PDF、文档及其他已注册类型的专用处理器。
- 普通文件、research 来源、Science 产物各自的读取与身份规则。
- 命令行终端与多终端配置、会话关联、终端限制提示。
- 普通 Browser 的地址／画面状态、输入、适应／1:1、前置窗口和接管 Done。

普通浏览器与 Science 是两个独立能力。Browser 的 Done 可能回应原会话的接管请求，不能替换成单纯关闭标签。[S14]

### 4.11 Science

Science 提升为顶级入口，内部清楚区分“原生页面／实例／产物”。可以按既有视图能力组织，不要求新增后端操作。

保留：

- 没有 Pi 会话时打开目录 Science。
- 工作区与绑定实例视图。
- 输入开关，默认关闭及无有效画面时的禁用条件。
- 适应窗口／1:1、重连、文本输入桥。
- 检查中、等待画面、接收画面、不可用、未知、过期等状态。
- 实例列表、刷新、详情、最后观测时间及请求模型；请求模型信息不作为实际执行身份的证明。
- 文本、图片、PDF 产物预览，原始下载、重载和完整性检查。

关闭 Science 视图仅退订画面，不停止、取消或重跑独立后端任务。切换目录、身份或替换连接时清除旧帧与不再属于当前范围的实例，忽略迟到响应。同一所属范围断线时，画面清空，实例列表可保留上次观察并明确标记陈旧，不能显示成仍在实时更新。未记录的 Science 用量或费用继续显示未知，不套用主会话金额。

仓库文档仍保留 Science 端到端和部署环境的验证边界，UI 改版不能把“有入口”写成“各环境已联通”。[S01][S15]

### 4.12 截图未展开、但必须单独核对的能力

**消息队列是可操作的。** 当前 useSessionActions 已提供 follow-up 队列的编辑、移除、提升、清空；编辑文本时图片由 bridge 保留。Steer 与 follow-up 是不同投递类型。不能根据 App 中较旧的“只读队列”注释删掉实际操作。停止后的队列处理以当前 handler、bridge 和部署行为共同核对，不沿用过时注释推断。[S19]

**运行控制有三个层次。** Stop、Force Stop、Stop after turn 分别对应中断、强制停止、完成本轮后停止；后台进程的控制又有自己的范围。会话卡片变薄后，仍要保留 ProcessSafetyChip 或等价的进程提示与入口，不能把所有操作合并为“停止所有”。

**会话菜单包含开发工作流。** 除重命名和归档，现有菜单还覆盖 Git commit、切换分支、push、PR、merge、关闭工作树，以及 OpenSpec 的 continue、fast-forward、apply、verify、archive、archiveAnyway、explore、detach、new、propose、bulk archive 等。应直接复用 deriveSessionMenu 及其 capability／禁用原因，不能根据截图重写少量按钮。[S20]

**会话头部信息仍需可达。** Pi 版本、Vault 绑定、用户 tags、只读 phase、Seek 和变更文件汇总，可收进会话详情或紧凑工具栏。标签、phase 与会话来源不同；归档与自动隐藏的 headless worker 也不同，过滤器不能混用。

**编辑器已有15种真实文件查看器。** asciidoc、audio、binary-warn、diagram、docx、email、html、image、markdown、mermaid、monaco、pdf、pptx、spreadsheet、video 均须保留原识别与处理能力；伪标签 diff、terminal、url、live-server、plugin、research、science 继续经原机制路由。[S21]

文件区还包含 Changes、文件名／全文搜索、标签重排与未读提示、后台打开不抢焦点、磁盘变化验证、保存基线、reload／dismiss、系统打开能力判断。目录编辑器与会话编辑器的监视能力不同：当前 FolderEditorView 主要依赖手动 Refresh，不能在新文案中宣称两者已经具有相同的实时监视能力。

**布局迁移要保留现有挂载策略。** 桌面 full 编辑模式中聊天保持挂载但隐藏，以保护草稿和滚动；平板 replaceChat 是另一种行为。新主视图应通过适配层复用这些状态，不简单用条件渲染反复卸载对话、终端和同一个 viewer，也不同时在新旧区域重复挂载同一实例。弹层需沿用 pane 边界处理，避免模型菜单等被分屏裁切。[S22]

**设置不只包含外观。** 现有设置有 provider、Pi、Dashboard、服务器、会话、账单、远程服务器、gateway、安全、访问、Vault、服务、runtime、add-ons、plugins、OpenSpec、skills、agents、extensions、prompts、themes、developer、instructions 等组，并存在插件设置页。继续复用 SettingsDraftRegistry／Provider 的跨页面脏草稿和保存协调，不在新壳层把离开某页当成丢弃草稿。[S23]

**撤销编辑还要保留图片与精确消息身份。** 沿用真实 undo-last 能力、归档／连接／空闲／重放／历史缺口条件；复制Markdown、复制纯文本、从某条消息Fork时传递准确entryId。新界面不能用本地删除气泡模拟撤销。

## 5. 功能迁移与保留验收表

下表是最低清单。实施者应补入实际部署中的额外插件与入口，并在最后一列填写测试证据，不能仅打勾“保留”。

| ID | 现有功能族 | 新位置 | 必须证明的行为 |
| --- | --- | --- | --- |
| F01 | 文件夹／工作区增加、切换、设置 | 项目选择与项目设置 | 路径、目录和工作区身份不变 |
| F02 | 搜索、过滤、分组、已结束、归档 | 左栏与全部会话 | 所有旧会话可找到 |
| F03 | 新建普通会话／工作树会话 | 新建菜单 | 使用原创建路径和条件 |
| F04 | 恢复、Fork、重命名、归档／关闭 | 会话菜单及头部 | 行为与数据不变 |
| F05 | OpenSpec 关联、变更与工作树操作 | 会话菜单／OpenSpec | 原可用性判断与上下文保留 |
| F06 | 主对话、思考、工具和自定义消息 | 对话 | 全文、顺序、复制、流式行为保留 |
| F07 | 普通发送、队列、steering、后台 | 输入区 | 消息送到正确会话及通道 |
| F08 | 停止、撤销并编辑 | 输入区／消息操作 | 不误停其他会话，不声称撤销外部操作 |
| F09 | 模型、provider、思考级别 | 输入区／模型设置 | 真正生效的配置与原写回不变 |
| F10 | 历史定位、Seek、恢复状态 | 会话工具栏 | 旧入口和历史内容仍可用 |
| F11 | 分屏、拖拽、三组比例、全宽 | 布局菜单 | 现有标签与状态不丢 |
| F12 | 冻结目标、实际阶段、控制环状态 | 研究工作台 | 正式状态与查看筛选分开 |
| F13 | 五阶段独立会话与首条 Prompt | 工作流进度 | 浏览不启动，确认后按原方式创建 |
| F14 | 接续／新工作流指令 | 工作流进度 | 指令生成／复制与启动分开 |
| F15 | 协作画布、列表、角色矩阵 | 智能体 | 所有原模式与筛选可达 |
| F16 | 图搜索、聚焦、缩放、分页、轮次 | 智能体 | 数据更新不破坏视口 |
| F17 | Agent 详情与原生完整对话 | 统一详情区 | 真实父会话／运行 ID 对应正确 |
| F18 | 监督、文本纠偏、快捷模板 | Agent 详情／监督入口 | 显示实际目标与实际回执 |
| F19 | 主张、证据、验收、反例、义务 | 主张与评审 | 每个原字段可见且来源不变 |
| F20 | 流程评审和发表授权 | 主张与评审 | 与逐条科学验收分别显示 |
| F21 | 尝试台账、动作、历史审计 | 历史与审计 | 最近摘要之外仍能查看全部 |
| F22 | 全部看板 | 研究工作台 | 完整聚合视图仍可打开 |
| F23 | 目录／历史资料接入 | 资料接入与项目设置 | 来源选择、计划、授权、草案完整保留 |
| F24 | 历史复核与接入恢复 | 接入任务详情 | 两版本覆盖与恢复条件不被混写 |
| F25 | 成员关系与创建时加入选择 | 会话菜单／创建流程 | 普通会话与工作台成员仍可选 |
| F26 | 研究预算与观测用量 | 总览与预算 | 次数、请求、响应、token不混算 |
| F27 | 接入预算、无限制、补充授权 | 接入详情 | 不误续期、清零、自动继续 |
| F28 | 来源快照原文与摘要／hash | 来源查看 | 仍读取原快照，完整性提示保留 |
| F29 | 会话费用与主／子代理分账 | 顶部费用详情 | 同一 fixture 金额与旧版一致 |
| F30 | TPS 与性能历史 | 费用详情→性能 | 历史与实时状态不丢 |
| F31 | 月报、目录／会话／模型维度 | 计费统计 | 月份与筛选语义保持一致 |
| F32 | 文件树、编辑、标签、差异 | 文件 | 未保存编辑与定位不丢 |
| F33 | 专用预览与插件 file handler | 文件／插件处理器 | 不被通用文本查看器替代 |
| F34 | 终端、Shell、多终端 | 底部工具区／原入口 | 原操作范围与运行实例保留 |
| F35 | 普通浏览器 relay 与 Done | 浏览器工具区 | 回应正确原会话，关页不伪装完成 |
| F36 | Science 原生画面及输入 | Science | 无会话可打开，输入条件不变 |
| F37 | Science 实例及状态 | Science→实例 | 当前目录、身份及新鲜度正确 |
| F38 | Science 产物预览／原始下载 | Science→产物 | 真实 task/artifact 绑定与hash不变 |
| F39 | 自动化、Goals、Flows | 项目工具 | 原看板、运行入口、配置仍可达 |
| F40 | 知识库、MCP、OpenSpec | 项目工具 | 不删除索引、配置、操作及状态 |
| F41 | 角色、技能、记忆、团队等扩展 | 更多项目工具／插件管理 | 注册入口与槽位完整 |
| F42 | 设置、主题、语言、显示偏好 | 设置与连接 | 旧偏好迁移并可恢复 |
| F43 | 所有插件命令、徽章、工具渲染 | 对应原宿主槽位 | 不是只保留菜单名称 |
| F44 | 后台插件 feed 与订阅 | 壳层／数据宿主 | 视觉收起不卸载必要行为 |
| F45 | 深链接、返回、直接打开旧地址 | 路由兼容层 | 编码路径、session ID和目标不丢 |
| F46 | 断线、重连、覆盖与过期提示 | 全局状态／详情 | 不展示其他项目旧数据或假活跃 |
| F47 | follow-up队列编辑、移除、提升、清空 | 输入区队列条 | 文本修改不丢图片，Steer与Queue不混用 |
| F48 | Stop／Force Stop／Stop after turn | 输入与进程控制 | 保持各自停止范围和既有队列语义 |
| F49 | 后台进程与ProcessSafetyChip | 紧凑会话行／详情 | 卡片折叠后仍可知晓和控制后台工作 |
| F50 | Git／PR／工作树及完整OpenSpec操作 | 原菜单适配层 | 保留动作、禁用原因和确认条件 |
| F51 | Pi版本、Vault、tags、只读phase | 会话工具栏／详情 | 信息与筛选范围不混淆 |
| F52 | 15种文件viewer与7类伪标签 | 文件与专用视图 | 不降级为只支持Markdown |
| F53 | 文件搜索、Changes、磁盘变化与保存基线 | 文件 | 后台开文件不抢焦点，保存冲突可处理 |
| F54 | 终端创建、重命名、关闭、聚焦和限制 | 终端工具区 | 单一keepalive实例，不重复启动或意外杀死 |
| F55 | 设置全目录及插件脏草稿保存 | 设置 | 跨页草稿保留，按原规则协调保存 |
| F56 | 工作区排序、跨区移动及headless过滤 | 项目／全部会话 | 原分类、排序和隐藏行为可恢复 |

## 6. 状态与交互不变量

### 6.1 四种状态分别建模

- 连接状态：当前前端与服务是否连通。
- 执行状态：会话／任务运行、等待、失败或结束。
- 科研状态：主张及条件是否被证据支持、部分支持、未定等。
- 查看状态：当前选中会话、阶段、标签、拓扑节点或布局。

不能用其中一种代替其他三种。切换查看状态不能自动改动执行或科研状态。

### 6.2 作用域隔离

新布局复用现有 apiBase、cwd、连接 generation、adoption／charter、session ID 与 execution ID 范围。

- 页面偏好可以保存，但不能只以显示标题作为标识。
- 切换项目清理旧请求结果，保留属于原项目的草稿。
- 异步返回必须确认仍属于当前 scope。
- 文件标签、Science lease、费用 snapshot、Agent详情与终端各保留原所属关系。
- 不重复建立多个相同轮询器或 WebSocket 订阅来支持新的顶部与侧栏摘要。
- 卸载视图时只释放该视图资源，不代替用户结束运行任务。

### 6.3 内容完整性

折叠只限制显示高度，不改原文、不截断复制结果。分页必须提供总数或“仍有更多”提示；如果后端只提供有限窗口，应明示范围，不能称为全量。

科学证据、来源 hash、运行 ID、确切模型和错误日志允许在详情中收纳，但不能删掉。

## 7. 静态源码发现：建议随改版纠正的显示问题

以下结论来自指定提交的代码路径检查，不表示已在用户线上复现。实施时应写针对性测试并核对实际数据。

| 优先级 | 发现 | 建议 |
| --- | --- | --- |
| P0 | ResearchPipelinePage 的总览预算徽标给 dailyMaxAttempts 加上 ¥ | 使用正确预算接口和“次”单位，人民币费用使用账单数据 |
| P0 | ResearchAgentDetail 无 sessionId 时不发送 API，却仍置为 delivered | 区分本地备注／无法投递／已提交／失败，不生成假回执 |
| P0 | 主 Agent 入口选择只更新组件状态，并可默认取最近活跃会话 | 命名为当前交互入口，真实来源和调度角色另行展示 |
| P1 | 配置技能、当前工具与文本提及混为“实际调用技能” | 分成配置技能、已观测工具、文本提及 |
| P1 | 无输出、无阶段或过期记录有时仍显示活跃／持续推演 | 缺失显示未记录，过期优先显示上次状态并停止活跃动画 |
| P1 | lastActivityAt 被用于回退结束时间 | 结束时间与最近活动分别显示，不据此编造耗时 |
| P1 | 部分列表把 Lead 创建的会话归为工作流创建 | 共用三分类来源组件 |
| P1 | “全量”Subagent清单实际只取前36条，部分历史／详情只取12条 | 改称最近摘要并提供分页／查看全部；缺服务端能力时明确范围 |
| P1 | 快捷纠偏包含固定的 AIMD 1200K 等条件 | 保留快捷模板能力，使用项目条件或可编辑模板 |
| P1 | 活跃卡片可能覆盖用户主动收起选择 | 保留折叠偏好，用小型新活动提示替代强制展开 |

主要定位：ResearchPipelinePage.tsx、ResearchAgentDetail.tsx、ResearchExecutionPanels.tsx、ResearchAgentCanvas.tsx、research-projection.ts。[S03][S08][S16]

## 8. 源码落点与复用策略

本表路径缩写：O = patches/dashboard-v0.20/overlay/；C = O/packages/client/src/；R = C/components/research/。明确标为“仓库根”的路径从pi-research-harness根目录计算。

| 修改范围 | 现有入口 | 实施意见 |
| --- | --- | --- |
| 全局壳层与路由 | C/App.tsx；C/components/shell/ShellContent.tsx | 拆出布局组合，保留原状态与路由 |
| 左栏 | C/components/shell/ResizableSidebar.tsx；C/components/session/下的SessionList.tsx、SessionCard.tsx | 增加紧凑呈现，保留菜单及插件能力 |
| 会话头部 | C/components/session/下的SessionHeader.tsx、SessionActionsPanel.tsx；C/lib/session/session-menu-items.ts | 导航与操作分组；不要手工复制一套菜单权限判断 |
| 对话 | C/components/chat/下的ChatView.tsx、ChatViewMenu.tsx、ToolBurstGroup.tsx、ToolCallStep.tsx、ThinkingBlock.tsx | 在原组件上调整密度／分组，保留渲染器 |
| 分屏 | C/components/split/下的SplitWorkspace.tsx、SplitWorkspaceContext.tsx、SessionSplitView.tsx、LayoutModeSwitch.tsx | 复用分屏和文件状态；统一外部控制入口 |
| 文件 | C/components/editor-pane/下的EditorPane.tsx、EditorTabs.tsx、pseudo-tab-registry.tsx、file-handler/ | 保留 viewer 注册和读写通道 |
| 科研页 | R/ResearchPipelinePage.tsx、R/ResearchTabViewer.tsx | 将外层布局与内容区分离，兼容现有research伪标签 |
| 协作 | R/ResearchExecutionPanels.tsx、R/ResearchAgentCanvas.tsx、R/ResearchAgentDetail.tsx | 分开视图组合，保留真实数据投影 |
| 预算／主张 | R/ResearchOverviewAndBudget.tsx、R/ResearchBudgetControls.tsx、R/ResearchClaimPanels.tsx | 同源读数，独立语义，收纳长表单 |
| 接入 | R/下的ResWorkflowAdoption.tsx、ResWorkflowHistoryReview.tsx、ResWorkflowIntakeAgent.tsx、ResWorkflowIntakeBudgetControls.tsx | 独立资料接入页面，保留协议与草稿 |
| Science | R/ScienceViewer.tsx、R/ScienceInstances.tsx、R/ScienceArtifactViewer.tsx | 迁移入口和容器，保持生命期与作用域 |
| 普通浏览器 | O/packages/browser-plugin/src/client/下的BrowserPaneTab.tsx、BrowserFrameSurface.tsx | 保留原生接管／输入／订阅语义 |
| 费用 | O/extras/speed-plugin/src/下的index.tsx、SessionCost.tsx、useSpeedStats.ts | 复用统计，改详情容器与布局 |
| 月报 | C/components/settings/BillingStatsSection.tsx | 原报表保留，新增直达入口 |
| 样式 | C/index.css 及现有主题系统 | 统一语义token和尺寸，不全局覆盖所有插件 |
| 插件 | C/generated/plugin-registry.tsx 与插件 manifest | 注册文件是生成产物，修改正确源头并重生成；不要手工删注册项 |
| 深链接 | C/lib/nav/route-builders.ts、原路由处理 | 保留旧URL、正确编码与返回目标 |
| 构建 | 仓库根：config/dashboard-v020.json；scripts/update-dashboard-manifest.mjs | 更新覆盖层清单及hash，保持固定上游校验 |

可以新增“工作区视图导航”“任务概览”“统一详情宿主”等展示组件；这些是建议新增的 UI 组合，不应各自实现第二份业务存储、任务调度或计费逻辑。

部分核心组件来自固定上游而未出现在覆盖层。修改它们时，应先在完整固定上游检出中定位，再按覆盖层规则纳入新文件，不能误以为“overlay没有该文件”就是“功能不存在”。

## 9. 分阶段实施与交付

### 阶段 A：功能基线与状态梳理

交付：实际部署增量清单、F01–F56映射、插件／路由／菜单清单、关键场景基线截图。

完成条件：每个旧入口都有新位置或明确保留机制；语义问题和布局问题分开登记。

### 阶段 B：视觉基础与导航壳层

交付：主题／间距／密度规则、全局顶栏、左导航、五主视图、统一布局菜单。

完成条件：旧路由可访问，现有对话与编辑器实际运行在新壳层内；没有用静态卡片替换真实组件。

### 阶段 C：对话、列表和详情

交付：紧凑会话列表、执行记录折叠、统一详情宿主、费用／性能入口。

完成条件：输入草稿、消息队列、停止／后台、撤销编辑、文件标签和插件内容均保留。

### 阶段 D：科研、协作与Science

交付：五阶段工作流、完整智能体视图、主张／历史／预算／接入页面、Science完整入口。

完成条件：范围和生命周期不变量通过；旧能力有可执行的新路径，未配置状态也正确。

### 阶段 E：回归与截图比对

交付：有结果的功能矩阵、定向测试记录、同数据同窗口前后截图、已知问题列表。

完成条件：功能保留、真实状态、数据完整性优先；其后再确认视觉接近本轮效果图。

### 阶段 F：独立构建与部署准备

交付：新构建目录、覆盖层manifest、运行依赖说明、切换与回退步骤。

必须先核对运行目录与仓库差异。保留旧构建和必要静态资源，再按实际维护流程切换。不要通过覆盖未知运行目录验证新 UI。[S01][S17]

## 10. 验证计划

本节是实施时的要求；本次没有执行这些回归，不能据本文声称已经通过。

### 10.1 既有命令的真实覆盖范围

| 入口 | 真实作用 | 不能替代的验证 |
| --- | --- | --- |
| 根 npm test | 顶层离线契约与主线监督离线检查 | 完整前端交互 |
| scripts/test-dashboard-v020.sh | dashboard-route-isolation.integration.mjs | 全部client、Science与费用测试 |
| npm run check:syntax | Shell、MJS／CJS语法 | TS／TSX类型检查 |
| npm run check:release | 发布文件、JSON及相关检查 | 布局和用户操作正确性 |
| test:dashboard:layout | 既有ChatView／NativeSubagents合成fixture | 新导航壳层和所有插件 |

旧布局测试当前默认目录与新构建目录可能不同。必须确认正在测试本次改动后的检出；不要构建新版本、却运行指向旧目录的脚本。[S18]

当前 prepare-dashboard.sh 没有调用旧 apply-dashboard-layout.mjs。长文展开、换行与局部滚动必须在实际新构建中核对，不能依赖旧文档里“构建时自动加入布局补丁”的描述。

### 10.2 优先复用或扩展的测试组

- SessionCard、SessionList、SessionHeader、SessionActions／菜单相关测试。
- ChatView、CommandInput、ToolBurstGroup／工具渲染、流式选择与滚动。
- SplitWorkspace、SplitWorkspaceContext、EditorPane、viewer registry。
- ResearchPipelinePage、ResearchAgentCanvas、ResearchAgentDetail、研究投影。
- ResWorkflowAdoption、Membership、SpawnChoice、预算与完整历史相关测试。
- ScienceViewer、SciencePane、ScienceInstances、ScienceArtifactViewer。
- browser plugin的Science只读代理、读取WebSocket与普通浏览器交互。
- speed-plugin的indicator、useSpeedStats、session-billing、billing-period。
- BillingStatsSection及server billing-report。
- 现有主题、显示偏好、路由及归档会话处理。

根据完整固定上游检出的实际package脚本运行定向测试与类型检查，不凭overlay目录的局部文件伪造不存在的命令。

### 10.3 必须验证的用户场景

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| T01 | 从旧URL直达会话、目录、文件、科研伪标签 | 打开原目标，返回行为正确 |
| T02 | 在项目A输入草稿，切B，再切A | 草稿不丢、不串发 |
| T03 | 模型运行时切研究／智能体／文件 | 原运行继续，停止按钮对应正确会话 |
| T04 | 对话中折叠工具记录、复制全文、流式更新 | 原文与复制完整，选择和滚动不跳变 |
| T05 | 停止后撤销并编辑最后消息 | 遵循既有可处理条件，回填正确 |
| T06 | 打开文件并编辑，切布局和页面 | 未保存内容、标签和文件归属保留 |
| T07 | 分屏、拖拽、三个比例、全宽 | 所有视图仍可用，布局状态合理记忆 |
| T08 | 科研阶段间浏览 | 不启动任务、不修改真实阶段 |
| T09 | 新建本阶段会话、修改Prompt、取消／确认 | 取消保留合理草稿，确认调用原创建过程 |
| T10 | 搜索智能体、聚焦、缩放、翻页和切轮次 | 保留全部记录，详情关联正确 |
| T11 | 用户／工作流／Lead创建与文件回退记录并存 | 来源与边关系不混淆 |
| T12 | 无sessionId对象尝试纠偏 | 不出现假投递成功 |
| T13 | 数据过期、断线、重连、切目录 | 显示历史／未知，旧数据不串入新范围 |
| T14 | 有36条以上子任务、12条以上历史 | 可查看其余数据，或明确服务端范围 |
| T15 | 接入覆盖未完成、模型不匹配、预算到期 | 保留原状态和确认条件 |
| T16 | 修改研究／接入预算并遇到版本冲突 | 不清零／自动启动，草稿和重载路径正确 |
| T17 | 相同账单fixture在顶部、抽屉、目录查看 | 同口径数字一致，去重逻辑未变 |
| T18 | 未定价、远程账单失败、跨北京时间月份 | 未知不变0，历史选择不影响实时金额 |
| T19 | 无Pi会话打开Science，切目录并重连 | 正确工作区；旧帧与迟到响应被隔离 |
| T20 | 关闭Science视图 | 仅退订，不停止后端任务 |
| T21 | 下载Science产物并查看预览 | 原始内容、类型、大小／hash正确 |
| T22 | 普通浏览器接管后点击Done | 回答正确会话请求，不只是关闭标签 |
| T23 | 逐项打开项目工具和插件入口 | 菜单、设置、渲染和后台feed均存在 |
| T24 | 360／768／1440／1920宽度及浅深主题 | 长标题可读、按钮可达、无整页横向溢出 |
| T25 | 键盘遍历、Escape关闭、焦点返回 | 菜单／抽屉可用，原上下文焦点恢复 |
| T26 | 队列中含图片，编辑／提升／移除／清空 | bridge保留正确图片，操作目标与顺序正确 |
| T27 | 分别使用Stop、Force Stop、Stop after turn | 复用原控制通道，队列与进程结果符合基线 |
| T28 | 折叠会话卡片后仍有后台进程 | 仍可见进程提示并进入对应控制 |
| T29 | 打开15种文件查看器及各类伪标签 | 识别、专用功能和插件处理未丢失 |
| T30 | 设置中修改多页及插件字段后切换 | 脏草稿和原保存协调仍有效 |
| T31 | 桌面聊天切全编辑再返回、后台打开文件 | 草稿／滚动保留，原焦点不被抢走 |

优先验证真实的用户行为及本次变化涉及的边界；无需为所有静态颜色另写镜像实现的测试。截图使用明确的演示数据，不能借用真实研究结果假装完成态。

## 11. 构建操作说明

实现本方案时，编辑覆盖层源码，而不是仅修改生成的 dist 或旧四补丁快照。

推荐顺序：

1. 从已确认的main基线建立隔离开发分支，记录部署增量。
2. 准备固定上游提交的检出；其HEAD必须与config/dashboard-v020.json一致。
3. 修改对应overlay文件，保留原组件与调用路径。
4. 用固定上游检出执行scripts/update-dashboard-manifest.mjs，更新覆盖层校验。
5. 将PI_RESEARCH_DASHBOARD_SOURCE指向不存在的新目录。
6. 运行scripts/prepare-dashboard.sh构建并核对覆盖层。
7. 在实际新目录运行定向前端／插件／类型与离线测试。
8. 用一致的fixture、窗口和状态逐屏检查。
9. 根据功能矩阵验收后，再准备实际环境切换。

不能通过删去baseBlob、SHA-256、固定上游HEAD或文件清单检查来绕过失败。manifest更新脚本应接收固定上游检出，不是harness仓库根，也不是任意latest上游。[S17]

## 12. 可直接交给本地开发AI的任务摘要

请以northkd/pi-research-harness的当前确认基线和实际部署增量为依据，实施本文描述的UI重排。视觉目标是浅色清晰工作台，并保留现有主题能力。

核心改动为：统一全局顶栏与项目会话导航；把对话、研究工作台、智能体、文件、Science设为明确主视图；科研页保留工作流进度、总览预算、主张评审、历史审计和全部看板；项目工具和插件完整迁移；底部保留终端、浏览器、日志；详情使用统一可展开区域。

必须先完成F01–F56功能映射，复用现有数据和业务组件。保持会话、子代理、科研记录、预算、计费、Science及插件的操作语义；修正本文列出的误导性显示。图中示例不能写死为真实数据。

先交付可验证的新布局，再分阶段替换卡片与视觉。完成后提交功能迁移矩阵、实际运行的定向测试、同场景截图和部署增量处理结果。不要以静态原型、只改CSS或根npm test通过冒充完整改版完成。

## 附录A：主要证据入口

所有链接固定到本次检查提交，避免main后续变化导致本文证据漂移。路径中的行号可由本地检出搜索定位；本文以文件级链接为准。

- [S01：0.20开发、构建与部署说明][S01]
- [S02：覆盖层manifest与上游固定版本][S02]
- [S03：科研工作台页签、预算徽标与布局][S03]
- [S04：研究工作台伪标签与分屏上下文][S04]
- [S05：生成的插件注册与挂载槽位][S05]
- [S06：README中的撤销编辑能力边界][S06]
- [S07：五阶段、阶段查看与预算总览][S07]
- [S08：协作视图、角色、来源与执行详情入口][S08]
- [S09：主张、流程评审、验收与发表字段][S09]
- [S10：资料接入与草案确认流程][S10]
- [S11：研究预算及观测用量][S11]
- [S12：会话／目录费用口径][S12]
- [S13：历史月度计费报表][S13]
- [S14：普通浏览器界面与接管行为][S14]
- [S15：Science画面生命周期][S15]
- [S16：Agent详情与纠偏发送路径][S16]
- [S17：覆盖层清单更新脚本][S17]
- [S18：0.20测试脚本的实际范围][S18]
- [S19：停止与可编辑follow-up队列][S19]
- [S20：会话、Git、工作树与OpenSpec统一菜单][S20]
- [S21：真实文件viewer及伪标签种类][S21]
- [S22：分屏挂载与弹层边界][S22]
- [S23：设置分组、脏草稿及插件保存][S23]

[S01]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/docs/RELEASE-0.20.md
[S02]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/config/dashboard-v020.json
[S03]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchPipelinePage.tsx
[S04]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchTabViewer.tsx
[S05]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/generated/plugin-registry.tsx
[S06]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/README.md
[S07]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchOverviewAndBudget.tsx
[S08]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchExecutionPanels.tsx
[S09]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchClaimPanels.tsx
[S10]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResWorkflowAdoption.tsx
[S11]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchBudgetControls.tsx
[S12]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/extras/speed-plugin/src/SessionCost.tsx
[S13]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/settings/BillingStatsSection.tsx
[S14]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/browser-plugin/src/client/BrowserPaneTab.tsx
[S15]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ScienceViewer.tsx
[S16]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/research/ResearchAgentDetail.tsx
[S17]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/scripts/update-dashboard-manifest.mjs
[S18]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/scripts/test-dashboard-v020.sh
[S19]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/hooks/useSessionActions.ts
[S20]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/lib/session/session-menu-items.ts
[S21]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/editor-pane/viewer-kinds.ts
[S22]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/split/SplitWorkspace.tsx
[S23]: https://github.com/northkd/pi-research-harness/blob/af2810437b39772db62201b9f86346cdb9d62dfc/patches/dashboard-v0.20/overlay/packages/client/src/components/settings/SettingsPanel.tsx
