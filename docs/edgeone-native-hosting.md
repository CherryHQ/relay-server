# EdgeOne 原生托管评估

核对日期：2026-11-05。目标是 **Relay runtime 全部托管到 EdgeOne，不保留源站**。
当前状态：平台能力验证中，尚未交付 EdgeOne runtime 或部署配置。

## 当前判断

不能只把 Bun 入口换成函数 handler。Relay 的 listener、connect、attach 是三个独立的
WebSocket 请求，必须同时落到持有在线映射与会话的同一个实例。角色和 target 在升级后的
控制帧里发送；当前客户端不会在 HTTP 握手阶段提供平台会话路由信息。

已核对的能力如下；“文档或代码存在”与“Relay 已运行通过”分开记录。

| 候选环境                | 已有证据                                                                                       | 尚缺的条件                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Node.js Cloud Functions | 官方示例返回 `websocket` 回调；CLI 1.6.47 的 Node Functions wrapper 有对应握手及二进制消息处理 | 官方将其定义为请求级无状态环境，未承诺不同请求共享实例；不能依赖模块内 Map 会合 |
| Makers Agents           | 官方承诺按 `Makers-Conversation-Id` 请求头进行会话亲和，实例存活期间可复用内存与连接           | 需证明同一 Agent 实例可以同时接受多条 WebSocket，以及其升级、发送缓冲和关闭契约 |

Agents 是后续验证的候选，不能把 Cloud Functions 的 WebSocket 支持直接套用到 Agents。
在核对的 CLI 1.6.47 中，Agents 使用独立的 HTTP server wrapper，经 `runtime.handle()`
返回 HTTP 响应；该入口未找到 Node Functions 的 `response.websocket` 握手分支。
这项源码检查不足以证明所有云端版本都不支持，但也不能据此交付一个可用的 Relay 适配器。
另外，官方插件中的 `WebSocketPair` 示例与上述 CLI/语音模板使用的回调形式不一致，
需以可复现的运行结果和正式接口说明确定实现。

站点 WebSocket 加速需要源站，不满足本次目标。腾讯云 SCF 的能力也不自动等于 EdgeOne
对外提供的能力；不把单独的 SCF、CVM、Docker 或现有 Cloudflare 服务当成这次的托管实现。

## 先验证的最小闭环

验证项目只使用随机标识和测试字节，不接入账号、设备凭证或生产 Relay。

1. 对 Node Functions 和 Agents 分别验证真实 WebSocket 握手；普通 HTTP 200 或 SSE 不算通过。
2. 在 Agents 上以同一平台会话标识同时建立三条连接，核对实例启动标识一致，并验证连接间
   的内存消息路由。PC listener 在手机 connect、PC attach 和数据连接关闭后都应继续可用。
3. 验证现有客户端如何到达该 owner。Agents 要求请求头，当前跨端 socket factory 没有
   自定义请求头契约。若由 EdgeOne 入口注入固定会话标识，必须验证该处理发生在路由之前、
   完整保留 WebSocket 升级且始终导向同一 owner；不能先假设普通 HTTP middleware 足够。
4. 双向发送至少 64 KiB DATA 加 24 字节帧头，确认不被转为文本、截断、合并或重排。
5. 验证慢读时发送队列有界，超过预算或回执期限能及时关闭；检查原生缓冲或可验证的
   收包回执机制。DATA ACK 不用于证明平台内部发送缓冲已经释放。
6. 分别记录空闲期限、活跃连接期限、实例最长存活时间，以及发布/回收时的关闭行为。
   文档中的请求执行期限不能直接当成已经验证的 WebSocket 期限。

只要三连接同实例或有界缓冲没有通过，就保持未支持状态；增加 KV 存储在线映射不能
让两个独立实例直接访问彼此的 socket，也不为绕过此限制增加逐帧持久化或轮询转发。

## 条件满足后的实现范围

- 首版沿用每部署一个会话 owner 的范围，承载多个 target/session；不按账号创建实例。
  平台路由标识只负责寻址，不能当作设备身份或授权凭证。
- `src/edgeone/` 负责平台入口、socket 事件、发送预算、计时和实例退出，复用 `src/core/`
  的会话与流控逻辑。`deploy/edgeone/` 只在实际接口确认后添加可部署配置。
- 协议包保持平台无关；如握手路由必须修改客户端，则单独明确跨端兼容契约与发布顺序，
  不把 Node.js 专有的 WebSocket 参数直接放进跨端客户端。
- 开发、构建和测试继续使用 Bun；云端执行环境由 EdgeOne 的公开契约决定，不能假设
  它支持 `Bun.serve` 或 Cloudflare Durable Objects API。
- 实例回收时旧流结束，由客户端重新会合并建立新的 Noise 通道。没有平台承诺的 socket
  休眠恢复接口时，不做旧 socket 或旧 Noise 流的透明迁移。
- 用户凭证、配对批准与业务数据继续由端点/独立后端持有；此适配不引入账号数据库。

## 本次验证边界

已读取官方文档、官方示例，并检查 npm 发布的 `edgeone@1.6.47` CLI 包及 registry integrity。
已准备隔离的最小 Agent 验证程序。本地 `edgeone makers dev` 即使指定
`--skip-env-sync --skip-ai-gateway-sync`，仍在启动前要求认证；当前未通过该步骤，
因此没有 WebSocket、会话亲和、云端部署或性能通过记录。

平台闭环通过后，再运行现有 `bun run smoke:relay wss://<host>/v1/relay`，并补充慢读、
listener 存续、实例退出和重新会合测试。最终记录应分开说明本地运行、真实云端运行、
客户端配对以及性能/成本，不能用编译通过代替平台验收。

## 参考来源

- [Makers Agents：运行模式与会话亲和](https://pages.edgeone.ai/document/agents)
- [Agents 快速开始：路由请求头与配置](https://pages.edgeone.ai/document/agents-quick-start)
- [Node.js Functions 接口](https://pages.edgeone.ai/document/node-functions)
- [官方语音模板的 WebSocket handler](https://github.com/TencentEdgeOne/pages-ai-voice-chat/blob/main/node-functions/websocket.ts)
- [官方插件 Node Functions 示例，核对版本 97f58ff](https://github.com/TencentEdgeOne/edgeone-pages-plugin/blob/97f58ffdb3f74221a651f573df2a49d24b6e0803/skills/node-functions/SKILL.md)
- [EdgeOne CLI 1.6.47 发布信息](https://registry.npmjs.org/edgeone/1.6.47)
- [站点 WebSocket 加速](https://edgeone.ai/document/46971)
