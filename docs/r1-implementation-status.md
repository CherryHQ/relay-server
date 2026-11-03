# 首批协议与客户端实现记录

日期：2026-11-04。本记录保留 R1 包实现和本地验证；后续 runtime 见[R2 记录](r2-implementation-status.md)，产品端接入尚未交付。
当前范围以[最小 Relay 架构](architecture.md)为准，已有辅助代码不构成额外服务的实施前置。

## 1. 已落地范围

- Bun workspace、锁文件、独立类型检查、构建、format/lint、包依赖边界检查与检查 workflow。
- relay-protocol：24 字节头的 DATA/ACK/CLOSE、ready 形状与匹配、参数限制；另有可选 proof transcript 和固定验证向量。
- relay-client：已完成接入的 socket 到 MessageStream 的适配、窗口、队列预算、取消与关闭；另有可选证明签名 helper。
- loopback 专用 TLS WSS harness：转发原始二进制帧，使用临时证书且正常验证 TLS，测试代码不进入包导出。
- 公开 remote-transport@0.2.5（依赖 remote-protocol@0.7.0）的真实 Noise 握手、双向消息、1 MiB 二进制上传和错误远端身份拒绝。
- 两个 tarball 在临时消费者中离线安装，检查无 Bun 全局类型的 DOM 消费者、运行时导入和浏览器 bundle。

两个包仍为 private / 0.0.0，未发布。
`relayRequests.ts` 只提供 `signRelayRequest`，没有实际 HTTP 会合、challenge 或登记接口。
签名 helper 本次保留为可选能力，不据此要求用户凭证服务或独立许可服务。

## 2. 凭证服务、混合云与状态边界

用户凭证服务独立，多厂商适配仅针对 Relay runtime。
设备身份、配对、业务授权及结果由端点负责；runtime 的默认职责是会合、转发、资源限制和清理。

首版使用有界内存维护在线映射、会话、短期凭据和计数。
不再将持久设备登记、租户模型、独立管理后端、配额账本或 SQLite 迁移列为下一批工作。
当前代码没有实现业务数据库，无需先选定其部署位置才能推进 runtime。

重启使旧临时会话失效，端点保留配对及再次会合信息并重连。
平台休眠确需恢复状态时，由实际选用的适配器处理最小状态；恢复失败应结束旧流。
免费托管与未来可选用户策略均不改变该基本边界。

## 3. 上游契约与缓冲决策

2026-11-04 桌面源码核对至 `504ae0eee1828e5f08e173dd486d088ef98412ec`，
[remote-transport 通道接口](https://github.com/CherryHQ/cherry-studio/blob/504ae0eee1828e5f08e173dd486d088ef98412ec/packages/remote-transport/src/channel.ts)
继续接受 MessageStream。本批不复制 Noise、设备身份、RPC 或上传业务。
该基线已有 QR v3 direct endpoints 和二进制上传；Relay 候选需基于双端当前协议扩展，
App 目标分支和两端实际接入仍待核对，不能沿用过时的 QR v2-only 假设。

当前默认 DATA 载荷 64 KiB、窗口 256 KiB、未确认帧最多 1024；握手选择只能收紧实现上限。
发送队列设为 2 MiB：现有 Noise 将完整 1 MiB 上传记录及附加头/tag 交给流，1 MiB 上限会误拒绝。
接收与原生 socket 发送缓冲仍各 1 MiB，队列最多 1024 项。
这些数值分别计量，不表示进程 RSS 上限。

发送复制调用方数据，Uint8ArrayList 逐块复制，避免额外完整拼接。
ACK 返还前保留完整窗口与项数容量，只接受真实已发送帧边界上的累计 ACK。
每轮 onDrain 等待新的信用；15 秒无 ACK 或 socket 排空进展则关闭。
取消/故障不重放旧密文；本批没有延时小帧合并或 ACK 批量策略。

## 4. 工具链与已执行验证

固定 Bun 1.4.4。首批实测使用原生 `bun fmt` 和 `bun check`；
当时该安装包没有可调用的原生 `bun lint`，暂用 Biome lint，formatter 已关闭。
TypeScript CLI 只生成包的 .d.ts，类型检查由 Bun 执行。

```sh
bun install --frozen-lockfile
bun run verify
bun run format
bun run perf:baseline
```

测试需要系统 openssl 生成临时回环证书、tar 检查包内容。
verify 顺序执行构建、独立类型检查、格式、lint/依赖方向、测试及打包消费者 smoke。
跨包引用按真实 dist 入口解析，单独运行测试前应先构建。

首批本地 verify 已通过：28 个测试、168 项断言，以及构建、三个独立类型检查、格式、
lint、依赖方向和离线消费者检查。CI 配置已创建，未执行 GitHub Actions。
这些是 R1 的历史验证范围，后续 runtime 的验证单独记录。

已在 Bun 1.4.4 / macOS arm64 / Apple M5 上执行三轮顺序 echo 基线，
每场景预热 3 次、记录 20 次，覆盖小 JSON、32 KiB JSON 和 1 MiB 上传。
原始记录在工作区 `.context/r1-baseline-20261104.json`。
p99 接近该小样本的最大值，RSS 包含两端和转发器，不能用作生产容量或费用结论。

## 5. 后续进展

R2 已实现[最小 runtime](implementation-plan.md)：临时会合与凭据、二进制转发、资源限制、关闭和排空。
下一步将该会合契约接入桌面/App，保持现有 Noise、配对及 direct 行为。

真实端点、完整自建、所选云平台与后台推送分别验收。
本地协议、打包或回环基线不能替代这些结果。
