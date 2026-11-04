# Relay 连接排查

适用现象：手机通过 Relay 发起配对后，桌面显示 Relay 不可用，随后反复重连。
目前已验证本地 session 与 listener 的独立生命周期，尚未复现这次云端故障；
仅凭 `Relay socket closed` / `Relay listener disconnected` 不能确定关闭原因。

## Workers / Durable Objects 采集

可以先单独更新 Worker，直接采集 `RelayDO` 日志；本次诊断不改协议，无需同步发布客户端。
下文新增的 `RemoteRelay` 字段需要包含诊断改动的桌面构建，未更新时可先对照旧桌面日志的时间。
先记录桌面、移动端版本、Worker 部署版本、Relay origin，以及复现时间和时区。
客户端仍须满足已有的 `probe` / `probe_ack` 要求，详见
[部署要求](../deploy/cloudflare/README.md#背压与客户端要求)。

在 Relay 仓库根目录，使用已登录的部署账号，复现前开启 tail：

```sh
mkdir -p .context
bun x wrangler tail --config deploy/cloudflare/wrangler.jsonc --format json > .context/relay-worker-tail.jsonl
```

Wrangler 配置的 Worker 名称和环境必须与手机/桌面的 origin 一致；命名环境加 `--env ENV`。
复现一次，保留配对前到首次断线、至少两次重连的记录，然后 Ctrl-C 停止采集。
不要仅用 `--status error` 过滤：协议拒绝和正常执行的关闭回调也可能造成断连。
`/healthz` / `/readyz` 只反映 Worker 入口，不能替代 DO 日志。

同时从桌面 Main 日志提取 `RemoteRelay` 上下文的事件。原有
`Encrypted remote transport error` 可以保留时间点，但要由下述 session 事件定位对应连接。
诊断日志不包含二维码、host key、attach ticket、验证码、密文或消息正文；不要另外开启帧 dump。

## 关联一次连接

桌面每次重试生成一个 `listenerId`，并记录 `attempt`、origin、target 前 12 位。
正常事件为：

```text
Relay listener connecting
Relay listener admitted       ownerEpoch
Relay session attaching       sessionId, ownerEpoch
Relay session ready           sessionId
```

数据连接结束会出现 `Relay data socket closed` / `Relay data stream closed`；
`listenerOnline: true` 表示这一时刻 listener 仍由桌面视为在线。
如果 listener 自身结束，应继续查同一个 `listenerId` 的：

```text
Relay listener socket closed  code, reason, admitted
Relay listener socket error   errorCode 或 httpStatus
Relay listener control rejected
Relay listener stopped        cause, phase, readySessions, pendingSessions
Relay listener retry scheduled retryInMs
```

Worker 的 JSON 行使用 `component: RelayDO`。`bootId` 每次 DO 构造变化；
`ownerEpoch` 和 `connectionId` 随 socket attachment 恢复。`sessionId` / `ownerEpoch` 可以
跨桌面与 Worker 关联；listener 则通过相同 target 前缀、epoch 和时间定位。
`session_offered.listenerConnectionId` 指向接收 offer 的 listener。

正常休眠恢复会出现新的 `bootId` 和 `runtime_ready`，保留相同 epoch 和连接；
单独出现新 boot 并不是故障。`socket_closing` 是 runtime 主动关闭意图，
`socket_closed` / `socket_error` 是平台回调。回调中的 `state: closing` 应通过
`connectionId` 回查此前的角色和关闭意图。

## 按首个异常定位

| 首个异常 | 判断与下一步 |
| --- | --- |
| 桌面 `1008 / TARGET_BUSY`；DO `listener_rejected` | 同一 target 仍有 listener。用 `activeConnectionId` 查它的关闭回调，区分重复桌面进程和旧连接尚未释放；不要通过重置 host key 掩盖问题。 |
| `STALLED`，`receiptDeadline` 已到 | 收包回执超时。按连接角色检查客户端版本与 `probe_ack`；字段为空的数据会话仍可能是 DATA ACK 超时。 |
| `message_rejected`, `phase: receipt` | 查 `cause`，例如重复、过期或不匹配的回执。只有相关连接应被关闭。 |
| 桌面 `Relay listener control rejected` | 控制消息解析或 listener 状态校验失败；对照 DO 同时刻日志与客户端版本，不需要打印原始消息。 |
| `restore_failed`，桌面可能收到 `1012 / RELAY_UNAVAILABLE` | attachment 恢复失败。查受控 `cause`、`bootId` 和部署版本；此路径会关闭对象拥有的 socket。单独一个 1012 不足以证明恢复失败。 |
| `checkpoint_failed` / `flush_failed` | 保存连接状态或 alarm 失败。前者带 `connectionId`，后者的 `phase` 区分 checkpoint 与 alarm；该路径会 abort DO。 |
| upgrade `503` / `429` | 查 `upgrade_rejected` 的恢复状态、容量或速率限制。503 不一定是源站不可达。 |
| 桌面 `1006`、HTTP/TLS 错误、心跳超时 | 查对应的 DO 事件是否存在。1006 本身没有关闭原因，不能据此归因 DO、网络或代理。 |
| `configuration_cancelled` | 桌面配置 owner 主动取消 listener；查看开关、origin 或服务重启的时间。 |

日志不逐帧打印。异常 Error 文本仅保留固定原因白名单，其余记为 `UNCLASSIFIED`；
桌面未知 peer close 文本记为 `UNRECOGNIZED`，避免对端文本混入凭证。
本实现没有把配对逻辑移到 DO，配对批准仍由桌面端负责。

## 本地验证与边界

```sh
bun test tests/cloudflare/runtime.test.ts --timeout 15000
bun run check:cloudflare
```

第一项覆盖会话关闭后 listener 继续接入、休眠恢复、占用冲突、回执超时和日志脱敏。
第二项使用真实本地 workerd 强制休眠，验证监听/会合状态恢复、同一 Noise 通道继续传输、
1 MiB 上传与反向响应、deadline 清理。它们不代表真实手机、桌面 Electron 和线上 Workers 的端到端验收。
