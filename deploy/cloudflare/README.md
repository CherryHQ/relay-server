# Cloudflare Workers + Durable Objects

这是托管 Relay runtime，可独立部署，不需要 Bun 服务器、Docker、Tunnel 或 Cherry 账号服务。
本地工具使用 Bun 1.4.4；Wrangler/Miniflare 使用 Node.js 24，线上执行环境是 Cloudflare workerd。
和 [Cloudflare Tunnel](../cloudflare-tunnel/README.md) 是两种部署方式。

## 启动与部署

在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run dev:cloudflare
```

在另一个终端验证本地入口：

```sh
bun run smoke:relay ws://localhost:8787/v1/relay
```

`bun run build:cloudflare` 只生成 dry-run 产物，不创建线上资源。
使用自己的 Cloudflare 账号部署前，修改 `wrangler.jsonc` 的 `name`，然后：

```sh
bun x wrangler login
bun run deploy:cloudflare
bun run smoke:relay wss://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/v1/relay
```

生产客户端保存该 HTTPS origin，通过 `/v1/relay` 使用 WSS；无需更换 QR 结构。
可以按 Cloudflare 官方流程绑定自定义域名。`/healthz` 和 `/readyz` 仅检查入口，不证明会话容量充足；
容量满时 upgrade 返回 503。正式部署仍需配置账户级用量限制和入口访问策略，资源限制只作用于当前 DO。

## 会话与休眠

当前一个部署对应一个固定名称 `relay-v1` 的 DO，可承载多个桌面、用户和会话。
现有协议在 WebSocket 建立后才发送 target，因此这一版不按 target 分片，不声称无限横向扩展。
更改 DO 名称或 namespace 会使原连接与新连接失去共同 owner，升级时应让客户端重新会合。

采用 `acceptWebSocket` 和平台 WebSocket 事件处理器。角色、ownerEpoch、等待期限、已消费票据、
DATA/ACK 计数及边界、速率桶和发送回执预算保存在 socket attachment 中。
App socket 是该会话快照的唯一持有者，桌面数据 socket 只保存 session 引用；密文不写入 attachment。
唤醒后恢复同一组 socket，不重复发送 ready、不重放 DATA，也不重新开放票据。
不兼容快照或缺失角色会关闭受影响连接，端点重新握手，已有配对不变。

没有常驻 `setInterval`。握手、waiting、未 ACK 数据和收包回执的超时使用 DO alarm；
只在需要更早期限时设置 alarm。ACK 不逐帧写数据库，空闲时至多执行一次已排定的清理 alarm，
之后不周期唤醒。平台协议级 ping/pong 不唤醒 DO；不增加业务层定时心跳。
代码更新、平台故障和真正断线仍可能中断连接，端点必须保留重连与业务恢复能力。

`new_sqlite_classes` 是 Cloudflare 的 DO 类型声明。本实现只调用 alarm API，
不建立账号、设备或消息表，也不使用 KV/SQL 保存会话；socket 附属状态随连接结束失效。

## 背压与客户端要求

Cloudflare WebSocket 没有可用的 `bufferedAmount`/`drain`，普通 DATA ACK 的序号可预测，
不能用它证明原生发送队列已经排空。

本适配器发送 `{v:1,type:"probe",nonce}`，客户端收到后原样回送
`{v:1,type:"probe_ack",nonce}`。128-bit 随机值位于之前输出之后；匹配回执证明接收端读取了
之前的 FIFO 输出，才释放对应的发送预算。这不返还 DATA 窗口，不进入 Noise 或业务流。
每个 socket 最多一个待确认 probe；按字节/消息数量触发，不按时间周期发送。
超出预算直接结束会话，直到平台 close/error 回调才释放预留容量。

使用本次更新后的 `relay-protocol`、`relay-client`。connect/attach/RelayStream 自动处理 probe。
桌面在线监听器必须在解析会合消息前调用：

```ts
import { respondToRelayProbe } from '@cherrystudio/relay-client'

if (respondToRelayProbe(socket, messageText)) return
const control = parseServerControl(messageText)
```

旧客户端不能直接切到这个入口：首次连接即发送 probe，以便尽早暴露不兼容。
Bun runtime 继续使用原生背压，不发送 probe；新客户端仍能连接 Bun。
协议外层二进制帧与原有 Noise、身份、配对协议保持兼容。

## 资源设置

默认每个 DO：128 个 socket、32 个 target、32 个 session、每 target 8 个 session；
每方向 64 KiB DATA、256 KiB window、64 个在途帧。
输出预算为每 socket 1 MiB、整个 DO 16 MiB，包含尚未被随机回执证实读取的输出。
在途帧数量上限保证双向快照低于平台 16 KiB attachment 限制。

可以在 Wrangler `vars` 中设置 JSON 字符串 `RELAY_CONFIG`，例如：

```json
{
  "vars": {
    "RELAY_CONFIG": "{\"maxConnections\":64,\"maxSessions\":16,\"maxSessionsPerTarget\":4}"
  }
}
```

配置校验禁止突破上述 socket/session/快照/总输出预算上限。
`closeGraceMs`/`drainMs` 是 Bun 生命周期参数，DO 不靠它们实现 terminate 或 SIGTERM 排空。
Workers 原生接收消息上限由平台控制，应用在回调中拒绝超过协议上限的消息；
输出预算不代表整个 isolate RSS、平台接收队列或 TCP/TLS 内存的上限。
容量与费用需要云端实测，不能把本地 smoke 当作负载测试。

## 验证

```sh
bun run verify
bun run build:cloudflare
bun run check:cloudflare
```

最后一项启动隔离的本地 workerd，在保留 socket 的情况下强制清空 DO 内存，
校验 constructor 确实重跑、ownerEpoch 保留、票据不可重放、序号/ACK 继续有效，
以及已经建立的 Noise 通道可继续上传 1 MiB 密文并接收反向响应。测试入口不进入部署产物。
需要 Node.js 24，测试结束关闭所有临时进程。未进行实际 Cloudflare 账户部署、云端休眠计费或长期压测。

官方依据：[休眠与 attachment](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、
[生命周期与定时器](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、
[WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)、
[计费](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
