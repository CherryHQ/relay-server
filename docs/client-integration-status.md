# 桌面与 App 接入记录

日期：2026-11-04。本批实现产品连接层，复用既有 Noise、配对批准、deviceId 和 grants。
用户凭证服务保持独立；本批没有账号接口、设备登记后台、业务数据库、推送或 vendor 部署。

## 1. 源码位置与依赖

Relay 公共接口直接在本仓库实现。产品改动放在本任务的独立 checkout，未修改其他正在工作的产品工作区：

| 仓库 | 基线 | 本地目录 |
| --- | --- | --- |
| Cherry Studio | `1a5e66a52462b045718ebbc901ca5c578563a655` | `.context/client-workspaces/desktop` |
| Cherry Studio App | `ff57136871e7f0f531f7d3a199842fcfebb16562` | `.context/client-workspaces/app` |

`.context` 不进入本仓库 Git；产品修改需要分别提交至各自仓库。补丁、源码基线和验证日志保存在
`.context/client-integration-20261104`，各产品 checkout 的日志在其 `.context/relay-packages`。
这份记录描述实现验收结果；仓库推送和产品 draft PR 不代表完成 npm 包发布或服务部署。

Relay 包目前为 private `0.0.0`。本地使用 `file:.context/relay-packages/*.tgz` 和 pnpm override，
App 同时使用桌面构建的新版 remote-protocol tarball。它们用于本地联调；正式合入前必须发布协议和
Relay 依赖、替换为真实版本并重建 lockfile。不能把包含本地 tarball 路径的修改当作已完成公共发布。
预览依赖的构建步骤见[客户端草稿联调](client-preview.md)。

## 2. 已实现

### Relay 公共包

`packages/relay-client/src/rendezvous.ts` 导出 `connectRelayStream` 和 `attachRelayStream`。
它们验证 origin、角色、session、ownerEpoch、limits 和 pending/ready 顺序，处理打开失败、总超时
及 AbortSignal。ready 回调内同步创建 RelayStream，防止遗漏紧随 ready 的 DATA。
成功后仍由传入的 signal 控制流生命周期；连接选择、重试和持久化由产品 owner 负责。

### 桌面

- `RemoteAccessService` 将 direct/Relay 汇入同一个 MessageStream → Noise → RemoteConnection 入口。
  LAN 关闭只终止 direct；Relay 监听断开只取消待接入连接；已 ready 数据流继续运行。
- `relayConnection.ts` 维护 listen/offer/attach、心跳和 1–30 秒退避，并限制同时接入数量。
  更改 origin、停用 Relay 或停止服务会取消相应连接。
- `relayHostKey.ts` 按 canonical origin 保存一个随机 host key，使用 safeStorage 或 0600 文件。
  既有加密密钥无法读取时明确失败，不替换；该密钥独立于 Noise 身份。
- 设置页面提供默认关闭的 Relay 开关、自建 HTTPS origin 和连接状态。即使 LAN/Gateway 没有启动，
  Relay 可用时也能创建邀请。host key 不进入二维码、IPC 返回值或日志。
- `remote-protocol` 加入 RelayEndpoint 和 QR v4；继续接受 v2/v3。`connection.endpoints` 增加可选
  relay；缺字段表示旧端未提供，显式 null 表示移除，capability 仍为版本 1。

### App

- `DesktopConnectionManager` 仍是唯一租约、连接、AppState 和重试 owner。一轮保持 15 秒预算，
  有 Relay 时先给 direct 最多 5 秒；没有候选或直连失败后尝试 Relay，不等待 mDNS 耗尽本轮。
- Relay 会合后继续进入原有 DesktopSession，验证固定的桌面 Noise 身份，使用原有配对和授权。
  已认证桌面明确撤销配对时终止恢复，不切换路径绕过撤销。
- QR v4 的 Relay 地址仅在身份验证和配对成功后持久化。SQLite 增量迁移只加 nullable relay 列，
  保留已有身份、deviceId、grants、历史和直连地址。地址同步受原有配对与 grants 条件保护。
- `relaySocket.ts` 和 `modules/relay-socket` 补上 RN WebSocket 缺失的发送缓冲计量。
  JS 队列上限 1 MiB / 1024 项，包含一个原生在途发送；原生完成后才扣除。桥接接收逐条确认，
  超时、取消和失败关闭连接。网络上使用二进制帧，原生桥仍使用有界 base64，并非零拷贝。

## 3. 验证与剩余边界

- Relay：`bun run verify` 通过，61 个测试；真实 WSS、Noise、双向记录、1 MiB 上传和取消；
  离线 tarball 安装、无 Bun 全局类型消费者及浏览器构建通过。
- Desktop：9 个相关测试文件、154 个测试通过，覆盖协议、密钥、listener 生命周期、邀请、LAN 和
  原有真实 WebSocket/Noise 路由；Renderer 类型检查、修改文件 lint、翻译及 Agent Note 检查通过。
- App：连接、配对、缓冲、存储和迁移共 166 个测试通过；二维码解析 31 个测试通过。
  App 和其规定的 workspace 包类型检查通过；修改文件 lint 通过。
- Desktop Main 全量类型检查受本 checkout 祖先目录的 Bun 类型影响；干净 HEAD 的独立源码副本
  同样出现 fetch.preconnect / Hono 等诊断。本次未修改相关业务代码，也不把该检查记为通过。

Android 原生模块 `:relay-socket:compileDebugKotlin` 已通过实际 Gradle 构建。
iOS Swift 语法检查通过，但完整原生编译未通过：ExpoModulesJSI 依赖的子构建找不到
`generic/platform=iOS Simulator` 目标，Xcode 报告 iOS 26.5 组件不可用，尚未编译到 RelaySocket。
外层构建能找到 SDK，因此不将该结果简化为 Relay 模块编译错误或编译成功；须在可用的 iOS
构建环境补跑。详细错误见 App checkout 的 `.context/relay-packages/compile-ios.log`。
原生模块需要随新的移动 native client 发布。原生构建记录见产品 checkout 的验证日志；
构建或单测通过不等于真实 Electron/iOS/Android 跨网配对、导入、撤销和前后台验收。
本次尚未完成这些产品端到端场景，也没有实际网络吞吐、耗电或进程内存基线。

Android OkHttp 的公开 onMessage 在完整消息组装后触发；当前大小检查可以限制桥接投递，
不能证明恶意超大消息在原生解析器内的分配有界。发布前需补齐这一原生接收限制及实测。
iOS 使用 maximumMessageSize；两端的 JS/原生队列预算均不代表整个进程或 OS/TCP 缓冲上限。

后续顺序：原生接收保护与双端实际验收 → 依赖发布与产品仓库合入 → 容器/TLS 自建闭环 →
按实际选用的云平台适配 runtime。无需先建设凭证后端或 Relay 持久状态库。

## 4. Workers/DO 接入补充

新增的 [Workers/DO runtime](../deploy/cloudflare/README.md) 使用随机收包回执约束平台发送缓冲。
共享包的 connect/attach/RelayStream 自动应答，桌面 `relayConnection.ts` 在会合消息解析前调用
`respondToRelayProbe`，兼容首次监听与后续 offer 期间的回执。
本地两端预览 tarball 及对应 lockfile integrity 已更新，App 原生 socket 已支持文本发送，无需新增原生 API。
本次桌面 listener 5 项测试及修改文件 lint 通过；App socket 适配回归及完整 workspace 类型检查通过。
App checkout 位于 `.context` 下，Jest 默认会忽略此绝对路径；本次聚焦运行仅在命令行设置
`testPathIgnorePatterns=/node_modules/`，没有修改产品 Jest 配置。
这些后续修改已提交并推送到现有 draft PR：
[Desktop #23505](https://github.com/CherryHQ/cherry-studio/pull/23505)（`c3fb241`）和
[App #1600](https://github.com/CherryHQ/cherry-studio-app/pull/1600)（`09d5845`）。
本地、远端分支与 PR head 一致，提交签名已验证；包发布、正式 DO 部署和真机验收仍待完成。
