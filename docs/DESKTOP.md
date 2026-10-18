# macOS 与 Windows 桌面客户端

**Pi Research Harness** 将定制 Dashboard、本地后端、Pi 运行时和科研配置放进同一个桌面应用。安装后直接打开工作台；使用安装包不需要另装 Node.js、npm 或先部署 Dashboard 服务器。

本版本沿用现有 Dashboard 页面与四个源码补丁，增加本地服务管理、独立配置目录和连接已有 Dashboard 的入口。新增桌面入口位于 [`desktop/`](../desktop/)。

## 1. 选择安装包

| 电脑 | 系统要求 | 安装文件 |
|---|---|---|
| Apple Silicon Mac，M 系列芯片 | macOS 13.5 或更高版本 | `Pi-Research-Harness-<版本>-macOS-arm64.dmg` |
| Windows Intel / AMD 64 位电脑 | Windows 10 或更高版本，x64 | `Pi-Research-Harness-<版本>-windows-x64-Setup.exe` |

macOS 只分发 DMG，Windows 只分发 EXE，避免在同一个下载包中重复放入同一应用的另一种格式。Windows ARM 原生包与 32 位安装包不在本次构建矩阵内。

macOS 最低要求由随包运行时决定：[Node.js 24 官方二进制要求 macOS 13.5+](https://nodejs.org/en/blog/migrations/v22-to-v24#platform-support)，[Electron 44 已停止支持 macOS 12](https://www.electronjs.org/blog/electron-44-0#removed-macos-12-support)。上表是兼容性要求；最终以对应平台的实际安装验证记录为准，较新系统的 CI 通过不等于最低系统版本已完成实机验收。

### 下载位置

打开本仓库的 [Desktop installers 工作流](https://github.com/northkd/pi-research-harness/actions/workflows/desktop-build.yml)，选择目标提交的成功运行，在 **Artifacts** 中下载对应文件：

- `Pi-Research-Harness-macOS-arm64`
- `Pi-Research-Harness-Windows-x64`

GitHub 将 artifact 作为 ZIP 下载；解压后取得该平台唯一的 DMG 或 EXE，以及同批构建的 `SHA256SUMS.txt`。外层 ZIP 是 GitHub 的下载容器，不再额外包含一份 `.app` ZIP。带 `-smoke-results` 后缀的是测试记录，不是安装包。Artifacts 配置保留 **30 天**；过期后需要重新构建。下载权限遵循仓库访问权限。

## 2. 安装与首次打开

### macOS

1. 双击 macOS arm64 的 DMG。
2. 将 **Pi Research Harness.app** 拖入“应用程序”。
3. 从“应用程序”打开客户端，等待本地工作台完成初始化。

本版本使用 **ad-hoc 签名**，尚无 Apple Developer ID 签名与 Apple 公证。首次打开可能出现无法验证开发者的提示。确认下载来自本仓库、文件未被改动后，可按系统提供的单应用打开流程操作：先尝试打开，再进入“系统设置 → 隐私与安全性”，在该应用提示旁选择“仍要打开”，然后确认。具体界面见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。

### Windows

1. 解压下载的 artifact，运行 `*-windows-x64-Setup.exe`。
2. 按安装向导选择目录；默认按当前用户安装。
3. 安装完成后，从桌面或开始菜单打开 **Pi Research Harness**。

本版本尚未使用 **Authenticode 代码签名**。如果 SmartScreen 显示“Windows 已保护你的电脑”，确认文件来源后，可在系统提供该选项时选择“更多信息 → 仍要运行”。企业管理策略可能不允许继续；此时应联系管理员。相关机制见 [Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)及[首次分发说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app#step-6-handle-smartscreen-for-new-apps)。

## 3. 首次配置模型

首次打开会自动创建独立科研配置并启动本地 Dashboard。进入 Dashboard 的 **Settings / 设置**，配置自己拥有的模型提供商凭据或所支持的登录方式，再选择可用模型与工作目录。

安装包不包含作者的 API Key、账号登录状态、私人会话或 SSH 凭据。本次安装与启动测试不发送研究提示词、不调用有认证的模型；页面启动成功不能替代本人模型账号的实际调用验证。

需要外部 Codex / Claude / agy CLI、浏览器登录或远程计算的工作流，仍需配置对应工具与账号。具体科研配置见[安装指南](INSTALL.md)和[可复刻内容清单](REPRODUCTION.md)。

### 随包内容

- 固定版本的 Electron 桌面程序、Node.js 24.15.0、npm、Pi 与 Dashboard 后端依赖。
- [`config/settings.example.json`](../config/settings.example.json) 中的 **13 个固定版本 Pi 扩展包**，以及本仓库的科研集成、角色模板、主线监督与撤销编辑扩展。
- 固定上游提交 `04985091706cb77d5e2f73bbf8b906966e9d97c7` 的 Dashboard，依次应用 [`patches/dashboard/`](../patches/dashboard/) 中的四个补丁，并保留文字布局与内容折叠定制。
- 许可明确的技能与第三方许可证。菜单“帮助 → 第三方许可证”可查看随包材料。

第 4 个 Dashboard 补丁包含开发中的功能候选；打入安装包不代表历史重放等全部功能已完成验收。范围见[开发快照说明](UPDATES-2026-10-18.md)。

## 4. 数据保存位置

客户端使用 Electron 的应用数据目录。菜单 **“工作台 → 打开科研配置目录”** 会打开实际位置，通常为：

| 系统 | 科研数据目录 |
|---|---|
| macOS | `~/Library/Application Support/Pi Research Harness/research/` |
| Windows | `%APPDATA%\Pi Research Harness\research\` |

其中 `agent/` 保存独立 Pi 设置、认证与会话，`dashboard/` 保存 Dashboard 配置和状态。应用偏好保存于上一层的 `desktop-settings.json`，运行日志位于上一层的 `logs/`；也可通过菜单 **“查看运行日志”** 直接打开。

首次初始化将扩展路径指向安装包内的资源。后续启动保留用户已有设置与手工关闭的扩展，仅维护本应用记录的资源路径。本地服务默认优先使用 `127.0.0.1:18400`，端口被占用时选择其他可用端口；客户端会自动使用实际地址。

更新安装包前先退出应用，并备份需要保留的科研数据。Windows 卸载默认保留应用数据；更换 `.app` 也不会删除独立数据目录。备份中的认证和会话属于个人资料，应自行妥善保管。

## 5. 本地工作台与已有服务器

**使用本地工作台：**选择“工作台 → 打开本地工作台”。后端由当前客户端启动，仅监听本机回环地址；默认关闭 tunnel 与局域网发现。

**连接已有 Dashboard：**选择“工作台 → 连接已有 Dashboard…”，输入服务基础地址。支持有效证书的远程 HTTPS 地址，或本机 `http://127.0.0.1:端口`、`http://localhost:端口` 等回环地址。账号、密码或令牌应在服务登录页面输入，不放进地址。连接模式会保存供下次打开使用。

连接远程服务后，页面所操作的文件、会话和模型配置属于该服务器。切换页面不会自动迁移本地科研目录。返回本地工作台仍使用本机独立配置。

### 关闭与退出

- **macOS 关闭窗口：**应用与本地后台仍运行，可点击 Dock 图标重新打开。
- **“退出客户端”或 macOS `⌘Q`：**如果本地后台正在运行，客户端会提示本地任务可能中断；确认退出后停止自身启动的本地后台。
- **Windows 关闭最后一个窗口：**进入退出流程。
- **已有远程 Dashboard：**客户端退出不会向该远程服务发送停止请求。

此桌面版本不接入上游 Electron 自动更新流程；随包后端也由桌面版本管理。更新采用重新构建、验证并安装完整客户端的方式。

## 6. 从源码构建

构建机需有 **Git、Node.js 24.15.0 与 npm**，并能访问 GitHub、npm registry、Node.js 与 Electron 的官方下载服务。原生依赖需要源码编译时，还需平台对应的编译工具。请在目标平台和目标架构的机器上构建。

在仓库根目录运行：

```bash
npm --prefix desktop ci
npm --prefix desktop test
node desktop/scripts/prepare.mjs
node desktop/scripts/download-node.mjs
```

`prepare.mjs` 准备固定上游源码、核对并应用补丁、安装锁定依赖、构建 Dashboard，组装应用资源。`download-node.mjs` 下载本机平台的完整 Node 运行时，用官方 SHA-256 清单校验，解压后实际执行 Node 校验版本和架构。

组装时会按依赖包声明的系统和 CPU 类型，精确移除两份 Pi 依赖树中不适用于本机的 esbuild 二进制包，保留目标平台工具与许可证，并在 `research-bundle.json` 中记录裁剪结果。打包检查实际执行保留工具的转换功能；构建机生成的 jiti 缓存也不随安装包分发。

然后只执行与当前构建机匹配的一条命令：

| 构建机 | 打包命令 |
|---|---|
| Apple Silicon Mac | `npm --prefix desktop run dist -- --mac --arm64` |
| Windows x64 | `npm --prefix desktop run dist -- --win --x64` |

产物写入 **`desktop/dist/`**。已有其他架构或旧版本产物时，先另行保存并清理旧输出，避免混淆。开发时可在准备资源后运行 `npm --prefix desktop start`；开发窗口不能替代打包应用的安装验证。

### 原生安装验证

在干净的对应平台构建机或 CI 中运行：

```bash
node desktop/scripts/smoke-installed.mjs
```

脚本实际安装或复制打包应用，并使用临时独立数据目录启动。验证后端健康响应、Dashboard 页面加载、内置 Node 版本与架构，以及应用退出后本地端口关闭。Windows 测试会执行实际安装与卸载，适合没有既有同名安装的测试机。

通过后生成 `desktop/dist/SHA256SUMS.txt` 与 `desktop/dist/smoke-results/`。JSON 报告记录原生平台、安装包校验值、启动结果和清理结果，日志供失败诊断使用。脚本不改写 `HOME` 或 `USERPROFILE`；只为测试指定独立的应用数据和报告目录。

## 7. CI 与验证边界

[`desktop-build.yml`](../.github/workflows/desktop-build.yml) 覆盖 `macos-15` arm64 与 `windows-latest` x64。`codex/desktop-*` 分支的相关改动触发构建，也支持手动触发。工作流只上传本仓库 Actions artifacts，不创建 GitHub Release、不发布 npm 包。

安装包仅在对应原生安装测试通过后上传；失败时保留可取得的诊断材料。每次交付应核对 **具体提交、两个原生作业状态及其 smoke 报告**。仅有打包脚本、ZIP 文件名、Linux 测试或成功构建日志，不构成 macOS 与 Windows 安装启动已通过的证据。

本次验证记录与具体构建链接由维护者在实际完成后补充。本说明不预先宣称最低系统版本、所有 13 个扩展的外部工具调用、有认证模型、远程工作流或长期后台任务均已验收。

## 8. 启动失败时

先选择“工作台 → 查看运行日志”，检查最新一次启动记录。如果提示缺少运行文件，重新下载同平台的完整安装包；如果连接已有服务器失败，核对基础地址、网络与 HTTPS 证书。报告问题时提供客户端版本、系统与芯片类型、出现问题的操作和经过脱敏的日志片段。
