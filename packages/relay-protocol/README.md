# @cherrystudio/relay-protocol

Cherry Relay v1 的可移植编码：DATA/ACK/CLOSE 二进制帧、会合/ready 消息及参数边界，
另保留可选的证明 transcript 工具。没有 Bun/Node API、网络调用、数据库或业务 RPC。
当前版本为 private，尚未发布。

encodeFrame 分配独立帧；decodeFrame 的 DATA payload 借用输入缓冲，保留时须复制。
头为 24 字节，网络字节序：版本 uint8、类型 uint8、保留位 uint16、seq uint64、
cumulativeBytes uint64、payloadLength uint32。DATA 类型 1，ACK 类型 2，CLOSE 类型 3。
保留位必须为零，单帧 DATA 最多 65536 字节。计数使用 bigint，进入 JSON 时须显式编码。

ACK 只表示流接收进度及信用返还，不表示业务完成或文件持久化。
parseRelayReady 只检查形状；连接 owner 用 assertReadyMatches 对照已确认的 session、epoch 和 limits，
随后仍通过现有 Noise 验证远端身份。

parseClientControl / parseServerControl 严格校验 4 KiB 以内的会合 JSON，
包含 listen/connect/attach/start/cancel 及对应响应，见[会合协议](../../docs/runtime.md#2-最小会合)。
会话生命周期、票据生成与消费、限流和实际网络行为由 runtime 负责。

`parseRelayProbe` 单独校验可选的 `{v:1,type:"probe"|"probe_ack",nonce}` 文本收包回执。
nonce 为 128-bit 随机值的小写 hex，只用于验证 socket 输出已被读取，不是 DATA ACK 或业务认证。
Cloudflare 适配器使用该扩展约束平台发送缓冲；二进制帧格式不变，Bun runtime 不要求该扩展。

可选证明编码覆盖 origin、purpose、HTTP 方法/路径、target、session、role、peer、challenge、nonce
和原始 JSON 的 SHA-256；每项 UTF-8 字节前加 uint32 大端长度，空 session 仍保留零长度字段。
哈希和 Ed25519 签名由调用方注入。vectors 提供固定帧、transcript 和签名验证向量。
采用该机制的调用方需负责 challenge 有效性、用途及权限判断；基础会合流程不强制使用此工具，
也不因为有证明编码就要求建设设备登记或用户凭证服务。

此包补充 remote-protocol 的 Relay 外层契约，不替代配对、Agent、配置或上传协议。
