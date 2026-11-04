# Bun Relay 运行与会合协议

日期：2026-11-04。单实例 runtime 已实现并通过本地真实 socket 验证。
桌面/App 接入代码已实现，原生验收仍待完成；容器和代理配置见[部署记录](deployment-status.md)。
本文描述 Bun runtime；Workers + DO 的休眠、alarm 与收包回执见[独立部署说明](../deploy/cloudflare/README.md)。

## 1. 启动

使用仓库固定的 Bun 1.4.4：

```sh
bun install --frozen-lockfile
bun run build
bun start
```

默认监听 `127.0.0.1:8787`。`GET /healthz` 检查进程，`GET /readyz` 在排空时返回 503。
WebSocket 入口为 `/v1/relay`，拒绝查询参数；凭据只放入 TLS 通道中的控制消息。
生产客户端使用 `wss`，TLS 可以由 Bun 或已有反向代理终止。

```sh
RELAY_HOST=0.0.0.0 RELAY_PORT=8787 \
RELAY_TLS_CERT=/path/to/fullchain.pem RELAY_TLS_KEY=/path/to/key.pem bun start
```

使用反向代理时省略这两个证书变量，代理需支持 WS upgrade，并保留健康检查和合理的长连接超时。
客户端显式保存并确认 Relay origin；不把来自旧入口的凭据跟随重定向送到其他 origin。
同一会话的请求、桌面在线连接和桌面数据连接必须到达同一实例。

`SIGINT` / `SIGTERM` 停止新接入，关闭在线入口和待会合连接，允许已 ready 流在期限内完成。
默认 10 秒后结束剩余流。重启不恢复旧 socket、ticket 或密文。

## 2. 最小会合

所有控制消息为 UTF-8 JSON，最多 4096 字节，包含 `v: 1`；未知字段和类型会被拒绝。
类型和解析函数由 `relay-protocol` 导出。数据帧继续使用已有 v1 编码。

1. 桌面为这个 Relay origin 生成并保存 32 个安全随机字节，以 64 位小写 hex 表示 `hostKey`。
   在在线 WebSocket 发送 `{v:1,type:"listen",hostKey}`。
2. 服务返回 `{v:1,type:"listening",targetId,ownerEpoch}`。
   `targetId = hex(SHA-256(UTF-8("cherry-relay-target-v1\0" + hostKey)))`，其中 `\0` 是 NUL 字符。
   App 保存 Relay origin、targetId 和原有配对信息；不获取 hostKey。
3. App 用新的 WebSocket 发送 `{v:1,type:"connect",targetId}`。
   此 socket 即该会话的 App 数据端。服务向它返回 `pending`，向桌面在线 socket 发送 `offer`。
4. `pending` 包含 `sessionId`、`ownerEpoch`、`limits` 和 `expiresInMs`；`offer` 额外包含 `ticket`。
   桌面用新的数据 WebSocket 发送 `{v:1,type:"attach",sessionId,ownerEpoch,ticket}`，也收到 `pending`。
5. 两端校验会话选择并安装接收器后，各自发送 `{v:1,type:"start",sessionId,ownerEpoch}`。
   服务在两个 start 都有效后发出 ready。接收器同步匹配 ready 并安装 RelayStream，再交给现有 Noise。
   ready 之前不可发送 DATA；异步等待 ready 后才安装接收器可能漏掉紧随其后的 DATA。

`hostKey` 只用于恢复在线入口控制权，不是产品登录凭据或 Noise 身份。
服务不持久保存它；已有在线入口不会被重复 listen 替换，连接 owner 应关闭旧连接或退避重试。
App 知道 targetId 只能请求会合，业务访问仍由桌面的 Noise、配对批准和业务权限决定。

ticket 只对当前 runtime 代际、当前 session 的桌面角色有效，成功 attach 时原子消费，
期限为整个 waiting 阶段的期限；attach/start 不延长期限。App 角色绑定最初的请求 socket，没有额外可重放票据。
关闭 App 请求即取消等待；桌面可在在线 socket 发送 `{v:1,type:"cancel",sessionId}`。
结束时向在线桌面发送 `{v:1,type:"session_closed",sessionId,reason}`；重复或迟到的 cancel 安全忽略。

数据会话结束不关闭桌面在线入口；在线入口断开只取消待会合会话，已 ready 的数据连接可继续。
桌面恢复同一个 hostKey 就会恢复相同 targetId，新会话使用新的 sessionId/ticket。
服务重启更换 ownerEpoch。丢失 hostKey 后需更新 App 保存的入口信息，但不因此删除 Noise 配对。

失败通过 WebSocket close 结束：1002 表示协议错误，1008 表示取消/资源/可达性问题，1000 为正常结束。
reason 使用固定值，包括 `INVALID_TICKET`、`TARGET_BUSY`、`TARGET_OFFLINE` 或协议的 CloseReason，
不回显凭据或原始输入。ready 后尽可能先发送二进制 CLOSE；拥塞时以 socket 关闭为最终结果。

## 3. 运行限制与观测

以下是初始资源保护值，不是经过云压测认证的容量承诺。环境变量可收紧或调整：

| 配置                                                         | 默认值                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `RELAY_MAX_CONNECTIONS`                                      | 512，含升级中、等待及关闭中的连接          |
| `RELAY_MAX_TARGETS`                                          | 128                                        |
| `RELAY_MAX_SESSIONS` / `RELAY_MAX_SESSIONS_PER_TARGET`       | 128 / 8，含 waiting 和 ready               |
| `RELAY_MAX_SOCKET_BUFFER_BYTES`                              | 1048576，单 socket 应用队列与原生缓冲合计  |
| `RELAY_MAX_TOTAL_BUFFER_BYTES`                               | 16777216，实例输出缓冲预算                 |
| `RELAY_MAX_QUEUE_ITEMS`                                      | 单 socket 1024 项                          |
| `RELAY_CONNECTIONS_PER_SECOND`                               | 实例 100 次 upgrade                        |
| `RELAY_FRAMES_PER_SECOND` / `RELAY_TOTAL_FRAMES_PER_SECOND`  | 单 socket 4096 / 实例 32768 条消息         |
| `RELAY_BYTES_PER_SECOND` / `RELAY_TOTAL_BYTES_PER_SECOND`    | 单 socket 8388608 / 实例 33554432 输入字节 |
| `RELAY_HANDSHAKE_MS` / `RELAY_RENDEZVOUS_MS`                 | 首条控制消息 5000 / 会合 15000             |
| `RELAY_STALL_MS` / `RELAY_CLOSE_GRACE_MS` / `RELAY_DRAIN_MS` | 15000 / 1000 / 10000                       |

速率桶最多积累一秒额度，消息计数包含控制消息和 DATA/ACK/CLOSE。实例容量不足返回 503，
upgrade 超速返回 429；已升级连接超限会被结束。定时回收的检查间隔至多 50 ms。
以上输出缓冲预算不包含接收缓冲、TLS、操作系统 TCP 缓冲或整个进程 RSS。

服务端独立验证 DATA 连续计数和窗口，只接受已被目标原生 socket 接纳的 DATA 边界 ACK。
即使对端提前返还窗口，输出队列仍受独立限制。仅在需要排队时复制二进制输入。
Bun send 的 -1 已接纳一次，0 表示非空消息被丢弃；后续发送等待 drain，参见
[Bun WebSocket 文档](https://bun.sh/docs/runtime/http/websockets#backpressure)。

嵌入运行时可调用 `BunRelayRuntime.getStats()` 查看连接、会话、原生/应用缓冲、拒绝数及收发字节。
字节累计以十进制字符串返回，指标不包含 target、票据、账号或消息内容；CLI 退出时输出聚合快照。
这批不增加公开指标后台、计费数据库或用户凭证服务。
