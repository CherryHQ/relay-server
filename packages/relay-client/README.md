# @cherrystudio/relay-client

将已完成会合接入的二进制 WebSocket 适配为现有 remote-transport 使用的 MessageStream。
当前版本为 private，尚未发布。公共包不依赖 Bun、账号服务、数据库或平台 SDK。

连接 owner 可以直接调用公共会合接口：

```ts
const stream = await connectRelayStream(targetId, { origin, createSocket, signal, log })
// 桌面收到 offer 后：
const inbound = await attachRelayStream(offer, { origin, createSocket, signal, log })
```

两个入口验证 HTTPS origin、会话、epoch 和 limits，在 ready 回调内同步安装二进制接收器。
默认总超时 15 秒，可通过 timeoutMs 收紧；AbortSignal 在成功后仍控制返回流的生命周期。
桌面长连接的 listen、offer 分发和重连仍由产品连接 owner 负责。
Cloudflare DO 会发送可选的随机收包回执，connect/attach 和 RelayStream 自动应答。
桌面 listener 在 `parseServerControl` 前调用 `respondToRelayProbe(socket, text)`，返回 true 时停止会合解析。
回执不进入业务流、不推进 DATA/ACK 计数；socket 的 send 必须同时支持文本和二进制。
已有会合实现也可以将检查完 ready 的 socket 交给低层构造器：

```ts
const stream = new RelayStream(socket, { log, limits, signal })
// 桌面交给 acceptSecureChannel；App 交给 connectSecureChannel，并校验预期远端身份。
```

R2 会合流程见[运行说明](../../docs/runtime.md#2-最小会合)。连接 owner 在发送 start 前安装接收器，
并在 ready 的消息回调中同步构建 RelayStream，以免遗漏随后到达的二进制帧。
本包不额外建立重连 owner 或替产品端保存会合信息。

RelaySocket 可接受浏览器 WebSocket，其他端侧 socket 由工厂适配。
send 返回 0 表示失败，-1 表示已进入原生队列，不能重发。
factory 必须保证事件异步送达、二进制 ArrayBuffer/Uint8Array、可靠的 bufferedAmount 和关闭行为。
Bun 回环 WSS 已验证，Electron/Hermes 真机仍待验证。

默认每方向 256 KiB credit、最多 1024 个未 ACK 帧，单帧 DATA 至多 64 KiB。
发送队列 2 MiB，接收队列和原生 socket 发送缓冲各 1 MiB，队列最多 1024 项。
发送队列容纳现有 1 MiB 上传的加密头/tag；各层分别计量，不是文件大小或整个进程的内存上限。
无 ACK 或 socket 排空进展最多 15 秒后关闭，测试可收紧期限。

send 复制调用者数据，返回 false 后应等待 onDrain({ signal })。
错误/取消清空队列并关闭连接；正常 close 等待已有 DATA 的 Relay ACK 和 socket 排空，不重放旧数据。
异步迭代器在每次 pull 之间暂停读取，提前结束会取消流，一个流只使用一个读取 owner。
事件消费者需自行约束其持有的缓冲。

`signRelayRequest(payloadJson, context, signer)` 是保留的可选 helper，只生成证明 envelope，
冻结异步签名前的上下文，不获取账号 token、导出私钥或发 HTTP 请求。
基础 runtime 不要求使用它，也不要求为它建设 challenge、设备登记或许可后端。
Bun 会合服务及双端接入代码已实现，验证与发布边界见[客户端接入记录](../../docs/client-integration-status.md)。
