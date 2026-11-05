# P2P 数据直连实现方案

日期：2026-11-04。状态：方案，尚未增加 P2P 运行代码或依赖。
本次按端侧传输能力重新划分职责：P2P 放在 Desktop/App 及共享 `remote-transport/p2p`，
现有 Relay runtime、控制协议和部署保持原样。STUN 地址由客户端配置，自建服务为可选项。

## 1. 选型与归属

使用现成 WebRTC DataChannel 库，只传数据；ICE、DTLS、SCTP 和拥塞控制由上游实现。
P2P 引擎随客户端发布，不需要部署一个 P2P server。自动跨公网建连仍需交换信令，通常使用 STUN
发现公网映射；两者可以复用已有服务。[WebRTC 官方说明](https://webrtc.org/getting-started/peer-connections)。

| 部分                                   | 实现                                    | 放置位置                                                |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| 桌面 P2P 引擎                          | `node-datachannel`，基于 libdatachannel | Desktop Main 的适配器与原生依赖                         |
| 移动 P2P 引擎                          | `react-native-webrtc`                   | App 适配器与 iOS/Android 原生构建                       |
| 信令格式、单次协商、DataChannel 流适配 | `remote-transport/p2p` 独立子入口       | `cherry-studio/packages/remote-transport`，两端共享     |
| 能力声明                               | `connection.hello` 的可选端侧版本标记   | `remote-protocol`；Agent、配置与配对业务契约保持原样    |
| 信令承载                               | 已认证的 Noise 通道中的受限控制消息     | 产品端接线；首版复用现有加密 Relay 通道                 |
| 协商与切换 owner                       | App 发起本轮选择，桌面校验并确认        | 现有 `DesktopConnectionManager` / `RemoteAccessService` |
| 公网地址发现                           | 配置已有 STUN 地址；可选自建 coturn     | 客户端配置，不属于 Relay runtime 部署                   |
| 备用数据路径                           | 现有 WSS Relay                          | `relay-server` 原有协议、SDK 与 Bun/DO                  |

上游依据：[node-datachannel](https://github.com/murat-dogan/node-datachannel)、
[React Native WebRTC](https://github.com/react-native-webrtc/react-native-webrtc)、
[DataChannel 标准](https://www.rfc-editor.org/rfc/rfc8831.html)。
当前 Electron 44、Expo 58 / RN 0.88 与原生库的兼容性由 P0 实测并锁定版本；Expo 需要新的原生构建。

Relay 只转发 Noise 密文，不解析 SDP/ICE、不决定 P2P 路径，也不增加 P2P 能力接口或 DO 信令快照。
此方案可使用现有 Relay 服务，无需为 P2P 升级服务端。通用协商逻辑接受注入的信令收发接口，
不依赖 Relay URL、targetId、会合票据或某个云厂商；首版只实现实际使用的加密通道接线。

既有 `remote-protocol` 仍负责业务契约和地址描述；P2P 控制消息的校验、版本与限制属于
`remote-transport/p2p`。不新增 npm 包、账号服务、设备目录或全局连接管理器。
Tailcat 保留为另一条选型备选，不同时集成第二套 P2P 后端。

## 2. 文件组织

以下均为计划位置，不提前创建空目录：

```text
cherry-studio/
├── packages/remote-protocol/src/
│   └── connection.ts           # hello 可选 connectionP2PVersion；无 SDP/ICE 内容
├── packages/remote-transport/src/
│   └── p2p/
│       ├── index.ts            # 独立导出 @cherrystudio/remote-transport/p2p
│       ├── ports.ts            # 注入的 DataChannel / PeerConnection / 信令接口
│       ├── signaling.ts        # 端到端控制消息、会话绑定、版本与限制
│       ├── negotiate.ts        # 单次协商；服从产品的取消与截止时间
│       └── DataChannelStream.ts # 分块、接收信用与原生缓冲预算，输出 MessageStream
└── src/main/services/remoteAccess/
    ├── p2pAdapter.ts           # 唯一导入 node-datachannel 的适配器
    ├── p2pConnection.ts        # 信令处理与候选流接线；受现有 owner 管理
    ├── RemoteConnection.ts     # 经授权的控制方法与切换门禁
    └── RemoteAccessService.ts  # 连接、身份、grants、代际及关闭

cherry-studio-app/
└── src/backend/services/desktopConnections/
    ├── p2pAdapter.ts           # 唯一导入 react-native-webrtc 的适配器
    ├── DesktopSession.ts      # hello 能力、加密信令及候选通道认证
    └── DesktopConnectionManager.ts # 本轮选路、AppState、预算和重连

relay-server/
├── packages/relay-protocol/    # 保持现有会合与帧协议
├── packages/relay-client/      # 保持现有 RelayStream / connect / attach
├── src/{core,bun,cloudflare}/  # 保持现有转发与恢复逻辑
└── docs/                      # 记录跨仓方案与可选自建说明
```

`remote-transport/p2p` 是独立构建与 package export；主入口不顺带加载 P2P。
子入口不导入 Electron、Node、Bun 或 RN 原生库，不依赖 `relay-client` / `relay-protocol`；
直接 WebSocket、RelayStream 和 DataChannelStream 都实现既有 MessageStream 契约。
数据分块和必要的消费信用由端侧适配负责，不在 Relay 协议里增加 P2P 帧。
不重复实现可靠 UDP、丢包重传或拥塞控制。

## 3. 建连、能力与兼容

首版流程是：**可达 direct 优先；否则先建立安全 Relay 通道，再尝试 P2P，失败继续 Relay。**
它不是在 Noise 之前直接竞速三条路径。这样换取服务端零改动，代价是 P2P 也要支付一次 Relay
建连与认证成本，随后还要在新流上建立 Noise；不承诺缩短首次建连时间。

1. App 按现有候选连接。direct 成功即交付，不额外尝试 P2P；否则按原样 v1 会合、ready、
   RelayStream、Noise、hello 和设备认证建立 Relay 通道。该阶段不向服务器添加字段或新消息。
2. 在既有宽松 hello 响应中声明可选的 `connectionP2PVersion: 1`；请求保持原样。
   新 App 仅在声明匹配、本机支持且已启用时发起 P2P。旧桌面不声明、旧 App 忽略该字段，
   都继续现有 Relay；不向未声明支持的对端发送 P2P 控制消息。
3. 首版仅在已配对设备的新连接、尚未向业务层交付前尝试一次。首次配对沿用现有 direct/Relay，
   下一次连接再尝试 P2P；已开始 RPC、订阅或上传的会话保持当前路径，不做后台热迁移。
4. P2P 控制消息由产品在加密 RPC 分发中显式注册、识别，schema 由 `remote-transport/p2p` 提供。
   使用独立版本和控制命名空间；具体方法、响应与候选传递顺序在 P1 固定为协议向量。
   不能把 SDP 插进旧业务消息、Noise 前言或 Relay 的会合控制消息。
   桌面处理器先检查已认证设备、当前 grants、功能开关与容量，未配对对端不得启动协商。
5. 每轮协商使用不可猜测的一次性关联值，绑定父安全连接、两端已验证身份、连接代际和期限；
   每条父连接最多一个候选。旧代际或跨设备消息拒绝，关联值不能替代设备认证。
   这些状态仅在产品端内存保存。
6. App 为 offerer，桌面为 answerer；通过旧 Noise 通道交换 SDP、trickle ICE 和 end-of-candidates。
   两端直接访问各自配置的 STUN，并创建一个 reliable、ordered DataChannel，固定 label/protocol；
   不设置有限重传次数/存活时间，不接受附加媒体轨道或任意额外 channel。
   早到 candidate 只在有界队列中等待 remote description。
7. DataChannel 打开只表示候选可用。将其适配成新的 MessageStream，建立全新的 Noise，
   校验与父通道相同的端点身份，再执行 hello 与设备授权，并验证一次性关联值。
   不复用旧 Noise 会话密钥，不把旧 access token 或切换关联值视为业务权限。

旧服务、新旧客户端、未配置 STUN、原生库不可用和显式关闭 P2P 都保留 WSS 基础能力。
二维码仍使用已有 `RelayEndpoint { origin, targetId }`；首版无需新 QR 版本。
P2P 探测、信令与切换不依赖 Cherry 账号或私有 API。

## 4. 选路、取消与恢复

App 的 `DesktopConnectionManager` 是本轮连接选择与重试的 owner；桌面的 `RemoteAccessService`
持有受父连接约束的候选状态并执行授权、切换确认及清理。共享子入口只做一次协商并返回候选流，
不全局重试、不管理 AppState，也不替产品提交业务路径。

- 准备阶段：旧 Relay 通道保持可用但未交付业务；新 P2P 候选只允许身份、授权和切换控制。
  候选的授权通过不自动开放业务 RPC；桌面必须显式设置门禁，不能直接复用“认证完即允许业务”的行为。
  旧通道一旦开始业务调用，就取消候选并固定 Relay，避免在途 RPC 与切换竞争。
- 提交阶段：App 请求切换，桌面串行校验本轮代际与当前授权、只接受一次提交，再由两端确认。
  一次只允许一个业务路径；提交后旧路径不得继续承接业务，确认完成后才把新通道交给业务层。
  P1 必须定义提交/确认、重复消息、超时和两条连接关闭的顺序，不能用本地 ready 标志推断双方已切换。
- 提交前的连通性失败：取消候选、清理 PeerConnection 和信令状态，继续交付已认证的 Relay 通道。
  提交结果不确定或一方未收到确认：关闭本轮相关流，由现有 owner 重连；不能两边独立猜测回退路径。
- P2P 提交确认后：主动释放本次 Relay 数据/信令通道，保留桌面 listener。
  主动释放必须与故障关闭区分，不能因旧通道的 abort/close 回调取消新 P2P。
  Relay socket 关闭仍遵守现有终态回调和资源预算规则。
- 身份不匹配、协议违规或授权撤销：终止本轮相关通道，不通过回退绕过认证。
  用户停用远程连接、更换 Relay origin 或撤销配对，由产品 owner 取消相关协商及 P2P。
- 真正断线：关闭旧流，重新走本轮流程、建立新的 Noise，并按既有业务恢复逻辑继续；
  不迁移密文、不自动重放命令。已建立的 P2P 不依赖 Relay listener 或 DO 对象持续运行。
  提交前父 Relay 通道真正断开时取消本轮；DO 正常休眠保留 socket，可继续传输加密信令。

沿用 App 原有 15 秒整轮预算和有 Relay 时至多 5 秒的 direct 阶段。
Relay 建连、两次 Noise/认证、P2P 协商与切换全部计入总预算；P2P 尝试初始上限 3 秒，
该上限覆盖 ICE、新 Noise/授权和确认，而不是只计 ICE。为回退与清理保留至少 1 秒，
剩余预算不足就立即交付已认证的 Relay，不增加另一轮超时。参数由真实网络验证后调整。

首版提供可关闭的 P2P 开关；说明直连会向对端暴露连接地址。产品保存开关与 STUN 配置，
不持久化 SDP、临时 ICE 凭据、候选 IP/端口或协商关联值。

## 5. 数据、缓冲与性能

- 所有业务仍由 `remote-protocol` 描述，经 `remote-transport` 的 Noise 保护。P2P 在网络上使用二进制，
  初始 DataChannel 消息上限 16 KiB（含端侧封装），同时服从更小的实际协商上限；1 MiB 记录分块。
- DataChannelStream 复用现有 MessageStream 背压契约，限制字节数、帧数、接收信用和排队量。
  必要的端侧分块/信用控制不承担 SCTP 的丢包重传职责；P0 验证后在子入口内固化。
- 应用队列、JS/原生桥在途、原生发送缓冲分别计量。发送失败不能视作已接纳，已接纳消息不能重发；
  对端确认不能单独释放独立的原生预算。必要时用最小适配补充完成/回执机制，库缺少可验证边界时
  不开放该端 P2P。旧 Relay 和候选同时存在的瞬时峰值也必须计入产品连接与内存上限。
- RN 二进制发送可能经过 Base64 原生桥且 bufferedAmount 异步更新，不能承诺零拷贝或按它做同步记账。
  依据：[RN 实现](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/src/RTCDataChannel.ts)、
  [桌面缓冲 API](https://github.com/murat-dogan/node-datachannel/blob/master/API.md)；以锁定版本实测为准。
- 端侧信令初始限制：SDP 32 KiB、candidate 2 KiB、每侧最多 64 个 candidate、每轮合计 256 KiB。
  按 UTF-8 编码后的完整控制记录检查大小，服从既有 Noise/RPC 记录和速率上限；不放宽 Relay 控制帧。
  早到队列、待发信令和并发协商都要有界，超限或畸形信令终止本轮。
- Relay 只统计实际密文字节与资源，不知道其中哪些是信令。P2P 吞吐、协商结果和直连比例由端侧观测。
  日志不写 SDP、ICE 密码、完整候选地址、票据或关联值；不增加 Relay 会话数据库或 DO attachment 字段。
- 目标是减少成功直连后的中继流量。比较时分别报告首次建连成本、最终路径、长会话吞吐、端侧 RSS/CPU
  和功耗；把额外 Relay/Noise 建连成本计入，不根据库名或一次 smoke 宣称性能提升。

## 6. 服务配置与自建

客户端接受可配置的 STUN 地址列表，可以使用已有服务或部署者自有服务；产品默认值和设置入口在
产品接入阶段确定，不通过 Relay 的能力 API 下发，不绑定官方域名，也不需要账号凭证服务。

完全自建用户可以额外部署 coturn `stun-only`，开放公网 UDP（例如 3478）。
它可与 Bun 位于同一 VM 的不同容器，或位于其他云；客户端直接访问。
现有 HTTP/WSS Cloudflare Tunnel 配置不承载 STUN，Workers/DO 也不运行 STUN。
可选自建步骤在部署说明中记录，不在本轮为 Relay 新增 `deploy/stun/` 或把 coturn 加入基础 Compose。
[coturn 配置参考](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)。

没有 STUN 时不保证跨 NAT 直连，STUN 不可达或 UDP 打洞失败时使用 WSS；
基础 Relay 部署不要求 STUN。首版不建设 TURN、TURN 临时凭据服务或新的信令服务。
Docker、Tunnel、Workers/DO 和账号/后台服务的现有部署边界保持不变。

## 7. 实施顺序与验收

| 阶段              | 交付                                                  | 必须证明                                                                     |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| P0 两端库原型     | 产品工作区薄适配、MessageStream/Noise 互通            | Electron ↔ iOS/Android 二进制双向、1 MiB、慢读背压、原生构建与清理；锁定版本 |
| P1 共享端侧能力   | `remote-transport/p2p`、hello 可选版本、控制协议向量  | 端到端信令校验、绑定、单次提交、记录/桥接预算、新旧客户端兼容和离线包        |
| P2 产品接入       | 现有 owner 接线、候选授权与业务门禁、STUN 配置和开关  | 提交前回退、提交不确定时重连、旧流清理不误杀新流、配对/撤销/前后台一致       |
| P3 跨网与部署兼容 | 使用未改动的 Docker / Tunnel / DO；可选自建 STUN 指引 | 真实 NAT、UDP 阻断、DO 休眠、运行时重启和成本对比；无需 P2P 服务端升级       |

P0 可以用测试信令通道隔离验证原生库。随后真实接入必须通过现有加密 Relay 通道，
不为原型修改生产 Relay 协议；失败先记录具体构建/互通障碍，保留现有 WSS。

验收至少覆盖：

1. 新旧 Desktop/App 与现有 Relay 的组合；新 App 连接旧桌面、旧 App 连接新桌面均无新控制消息误发。
2. 第一轮配对、再次连接、配置导入和 Agent 访问保持原有身份/grants；身份错误或撤销不得回退绕过。
3. 真实跨网 NAT、UDP 被阻断、STUN 不可达；没有官方账号、私有 API 或自建 coturn 仍能使用 Relay。
4. 候选未交付时业务被拒绝；提交/确认丢失、旧代际、取消与关联值重放不能形成两个活动业务路径。
5. 15 秒预算包含额外 Noise，超时不叠加；候选失败能继续旧 Relay，提交不确定则明确重连。
6. 成功 P2P 后本次 Relay 数据连接释放，中继业务字节停止增长；桌面 listener 流量单独核算。
7. P2P 成功后 Relay 重启/DO 休眠不影响其业务流；父通道在提交前断开则安全取消。
8. 慢读、桥接异步事件、信令洪泛、后台/换网和重复重连无持续资源增长；
   同条件测首连耗时、直连比例、吞吐、RSS/CPU 和功耗，验证库的原生限制。

本计划没有运行上述 P2P 验证，也没有发布新端侧子入口或部署 STUN。现有验证记录仅覆盖 WSS 路径。
