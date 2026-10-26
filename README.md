# FileDesk

面向 Synology DSM 7.2 的桌面文件管理客户端。Rust + Tauri 2 + React / TypeScript，优先 Windows，保留 macOS 扩展能力。

## 安装与更新

当前版本为 v0.4.1。下载 [GitHub Release](https://github.com/hyieq/DSFileDesk/releases/latest) 中的 `FileDesk-0.4.1-windows-x64.msi` 并运行，安装包包含视频解码器及第三方许可信息。MSI 使用固定 UpgradeCode，后续新版可覆盖升级；账号保存在用户应用数据目录，密码由系统凭据库管理。

打开左上角账号卡片，在账号窗口左下角点击“检查更新”。客户端通过 GitHub Releases 公共 API 检查正式版，按语义版本号比较，下载匹配的 Windows x64 MSI，验证长度与 SHA-256，随后可点击“安装更新”。安装将关闭客户端，存在文件传输任务时暂不允许安装。新版安装包在 GitHub 上随 Release 一起提供，仓库和 Release 必须可公开访问。SHA-256 优先读取 GitHub asset digest，兼容同一 Release 中的 `SHA256SUMS.txt`；软件目前未使用 Windows Authenticode 证书签名。

GitHub 请求受限或网络失败会显示错误，可再次检查。预发布版本和旧版本不会作为更新安装；下载失败或校验失败的文件不能进入安装流程。

已验证：前端生产构建、12 项前端测试、14 项 Rust 测试，覆盖模拟 DSM 上传鉴权与流式数据、更新版本比较、来源地址约束、摘要解析及篡改检测。真实 NAS 上传与原生视频画面仍需实机验收。

## 单实例与托盘

FileDesk 以单实例常驻运行。重复启动 EXE 时，新启动的进程直接退出，并显示、恢复及聚焦已有主窗口，不会重复登录 NAS。点窗口关闭按钮会隐藏到系统托盘，上传、下载及会话继续保留；单击托盘图标或右键选择“打开 FileDesk”可恢复窗口，右键选择“退出 FileDesk”可完全退出。

本地可先退出已有客户端，然后运行 `./scripts/test-single-instance.ps1`，验证连续四次启动均退出重复进程，原始进程持续存在。测试只会清理自己启动的进程。

## 发布 MSI

```powershell
npm ci
./scripts/package-release.ps1
```

脚本会在需要时下载官方 LibVLC 并验证校验值，然后构建 MSI；输出为 `release/FileDesk-<版本>-windows-x64.msi` 和 `release/SHA256SUMS.txt`。本地需要使用 rsproxy 时可传 `-UseRegistryMirror`。

版本号需同步修改 `package.json`、`package-lock.json` 根包、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，并让 Cargo 更新锁文件中的 FileDesk 版本。更新 `.github/release-notes.md`，提交后推送 `v<版本>` 标签，会触发 `.github/workflows/release.yml`：Windows 构建、前后端测试、上传 Actions 构件，最后创建 GitHub Release 并上传 MSI 与 SHA-256 清单。手动触发 workflow 只生成 Actions 构件，标签触发才公开发布 Release。

### v0.4.1 变更

- 防止重复启动多个进程和窗口，再次启动时恢复已有窗口。
- 关闭窗口后常驻系统托盘，托盘菜单提供打开和退出操作。

### v0.4.0 变更

- 增加 MSI 安装、GitHub Releases 检查更新、下载与校验、启动安装。
- 修正上传鉴权参数，避免 multipart 拖拽上传误报 DSM 119。
- 已完成的下载任务提供“打开文件位置”。
- 保留多账号、自动登录、图片与视频缩略图、图片预览、视频播放、亮暗主题及目录导航功能。

## 启动

安装 Node.js 20.19+、Rust 1.90、Visual Studio C++ Build Tools 与 Windows WebView2 Runtime 后：

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/fetch-decoder.ps1
npm run tauri dev
```

`npm run dev` 只打开浏览器预览；真实 NAS 连接、凭据保存、本地文件传输和原生拖拽必须在桌面版运行。

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Windows MSI 安装包位于 `src-tauri/target/release/bundle/msi/`，独立程序位于 `src-tauri/target/release/filedesk.exe`。首次构建需要联网下载依赖。

## v0.3.7 启动与登录

移除演示账号、示例文件、示例图片和模拟文件操作。启动后读取本地账号：无账号直接打开新账号登录表单；有账号预选上次使用账号（失效时选择第一个），登录前不发起目录请求。关闭登录后显示未连接空白状态，仍可通过大账号卡片重新登录。断开连接与删除最后账号不会回到演示数据。

## v0.3.3 主题与入口优化

主题选择与缩略图菜单共用圆角毛玻璃浮层组件，保留浅色、深色、跟随系统、键盘选择及外部关闭。移除左侧设置图标、右上角头像和底部账号管理三个重复入口，保留左上角大账号卡片；账号切换和新增账号按钮仍用于各自操作。浏览器已验证亮暗切换与账号卡片打开管理。

## v0.3.2 外观优化

缩略图尺寸选择改为圆角毛玻璃浮层菜单，采用主题配色、柔和投影、尺寸图标与选中标记；支持外部点击关闭、Esc、方向键、Home/End 和 Enter 选择。已验证亮暗主题和实际选择行为。

## v0.3.1 修复

左侧改为独立的递归目录树，按每层真实父路径加载，不再把当前目录内容挂到共享根目录。取消 6 项截断；箭头展开/收起与目录跳转分离；导航自动展开祖先，只高亮当前目录；账号切换隔离缓存，目录操作/F5 后重新加载，失败节点可点击重试。已在浏览器验证三级路径、9 个子目录完整显示、展开不导航及折叠操作，并增加路径层级回归测试。

## 当前功能

- 多 NAS / 多账号管理，独立登录会话，账号切换、移除与断开连接。
- IP / 域名直连（填写完整协议和端口，例如 `https://192.168.1.10:5001`）。
- 实验性 QuickConnect：HTTPS 发现、设备 ID 校验、直连候选及中继候选探测，可设置备用直连地址。没有可验证的连接就报错，不默默切换到 HTTP。尚未在真实 NAS/各区域中继验证。
- DSM 动态验证码登录；密码保存到 Windows 凭据管理器 / macOS Keychain，账号 JSON 不含密码，SID 仅保留在 Rust 进程内。
- 共享文件夹浏览、分页拉取、网格 / 列表视图、名称/大小/时间排序、当前目录名称过滤、路径输入、前后导航、收藏夹。
- Ctrl/Shift 多选、Ctrl+A/C/X/V、F2、Delete、F5、Alt+↑、Ctrl+L、右键菜单。
- Backspace 返回上级（编辑文字时不触发）；右键菜单点击外部关闭。
- 小、中、大、超大四档缩略图布局，记住尺寸；文件区空白处拖框多选，Ctrl/Shift 追加选择，拖到边缘自动滚动。
- 双击视频打开内嵌 LibVLC 播放器，播放/暂停、进度、音量、全屏；空格暂停、左右键快退/进 10 秒、Esc 关闭。
- 新建文件夹、重命名、删除、同账号内复制/移动、创建分享链接、基本属性。
- 文件和文件夹拖入上传，递归上传文件夹；文件下载，多选/文件夹 ZIP 下载；流式传输、进度与取消。
- 原生拖出：选中一个文件 → 右键“准备拖出到桌面” → 等待下载 → 按住文件上的拖拽按钮拖向资源管理器。当前为单文件预缓存方案，非延迟下载的虚拟文件拖放。
- 无账号启动直接打开登录窗口；已有账号预选上次使用账号。仅显示已连接 NAS 的真实文件。
- Windows 11 风格亮色 / 暗色 / 跟随系统，记住外观选择。Windows 原生 Acrylic 毛玻璃窗口，侧栏、菜单、弹窗及预览层使用半透明模糊背景；不支持原生效果时使用 CSS 背景回退。
- 图片、视频缩略图：网格及列表均支持，可见区域按需加载，最多 4 个并发请求，最多 80 项 / 20 MB 会话内缩略图缓存，账号隔离，F5 刷新重试。
- 双击图片或选中后 Enter 打开简易图片浏览器：上一张/下一张、方向键切换、25%–500% 相对适应窗口缩放、滚轮缩放、拖动平移、旋转、重置及 Esc 关闭。预览不会更改源文件。

## 缩略图和图片预览

通过 `SYNO.FileStation.Thumb` 获取 NAS 生成的缩略图，图片数据由 Rust 后端转交，浏览器图片 URL 不包含 NAS 地址或会话 SID。客户端不持久化媒体缓存到磁盘。

视频封面取决于 NAS 的索引、格式支持及封面是否已经生成。Synology 官方 API 文档限制视频缩略图在已索引的 photo / 用户 home 等支持位置；不能保证所有共享目录中的任意视频都有封面。当前未集成本地抽帧，缺失时显示占位，提示检查媒体索引，可按 F5 重试。即使没有封面也可双击播放。

播放器采用 LibVLC 3.0.23（含 FFmpeg 解码插件），支持 MKV、MP4、AVI 等常见容器；具体编码和硬件加速取决于内核与显卡能力。使用原生 Windows 子窗口嵌入画面，WebView 不承担解码。Rust 仅在 127.0.0.1 临时端口转发当前视频，随机令牌路径，支持 HTTP Range，沿用该账号的 HTTPS 校验策略，不把 NAS SID 传给页面或播放器。关闭播放撤销转发，无全文件预下载。尚无字幕/音轨手动选择、倍速和播放列表。

JPG、PNG、GIF、WebP、BMP、AVIF 优先读取原图（最大 32 MB）；失败时尝试 NAS 大尺寸缩略图。HEIC、RAW、TIFF、SVG 等采用 NAS 兼容缩略图预览，成功与否取决于 DSM 转换支持。兼容预览会明确标注。后端校验图片文件签名，不直接渲染 NAS 返回的 HTML / SVG 或错误页。

毛玻璃强度和是否可见受 Windows 版本、系统透明效果、显卡及远程桌面设置影响；本次未进行原生 Acrylic 的屏幕视觉验收。浏览器预览只能展示 CSS 模糊，不能展示桌面窗口后方的内容。

## 使用边界

这是可扩展的早期版本，并非 File Station 全功能对等版本。真实 DSM 7.2、2FA、QuickConnect、媒体缩略图和 Windows 原生拖拽仍需实机验收。当前没有全文/递归搜索、压缩解压、ACL 编辑、远程挂载、断点续传、跨账号复制、拖出文件夹、后台传输恢复及官方 Secure SignIn 推送认证。macOS 尚未打包验证，播放器原生窗口层也尚未适配 macOS。

同名上传不覆盖；下载通过独占创建目标文件，已存在时失败，即使系统另存为弹窗确认覆盖也不会覆盖。删除前有确认，回收站行为由 NAS 的共享文件夹设置决定。复制移动等长操作会轮询 NAS 后台任务；超过十分钟提示去 File Station 检查，不自动重试。关闭应用将终止本地传输，NAS 上已经启动的后台任务可能继续执行。

HTTP 只用于用户显式填写的地址。默认校验 HTTPS 证书，单账号可显式选择信任自签名/无效证书；这会跳过该账号连接的证书验证。生产环境建议给 NAS 配置可信证书。

拖出缓存保存在应用缓存目录的 `drag/`，可能包含敏感文件，当前需用户自行清理。上传取消时服务器可能保留部分文件，需要刷新确认。上传进度表示已发送给网络栈的字节数，NAS 成功响应前不会显示完成。

## 代码结构

- `src/App.tsx`：桌面布局、交互和调用层。
- `src/model.ts`：文件类型、排序、格式化。
- `src/media.ts` / `src/MediaThumbnail.tsx`：媒体分类、懒加载和缓存。
- `src/ImageViewer.tsx`：图片浏览器。
- `src/ThemeControl.tsx` / `src/theme.css`：主题切换和 Fluent 配色。
- `src-tauri/src/main.rs`：账号、凭据管理、Tauri 命令。
- `src-tauri/src/synology.rs`：API 发现、认证、目录/操作和 QuickConnect 解析。
- `src-tauri/src/transfer.rs`：流式传输、取消、预缓存及系统拖放。
- `src-tauri/src/media.rs`：媒体读取、大小限制、类型校验和原生窗口效果。

## API 参考

- [Synology File Station 官方 API](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/FileStation/All/enu/Synology_File_Station_API_Guide.pdf)
- [DSM 登录 API](https://kb.synology.com/en-global/DG/DSM_Login_Web_API_Guide/2)
- [QuickConnect 官方支持范围](https://kb.synology.com/en-global/DSM/tutorial/Which_services_support_QuickConnect)：第三方客户端不在官方支持范围。
- [QuickConnect 协议观察记录](https://github.com/nullvoidptr/qcon/blob/master/protocol.md)：仅用于实验性适配。

独立第三方客户端，与 Synology 无隶属关系。
