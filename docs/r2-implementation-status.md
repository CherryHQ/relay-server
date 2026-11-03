# R2 最小 Bun runtime 实现记录

日期：2026-11-04。范围为单实例会合、密文转发、资源保护、健康检查和有期限排空。
运行方法与控制协议见[运行说明](runtime.md)。

## 1. 已交付

- `src/bun/main.ts` / `runtime.ts`：单一 HTTP/WSS 入口、配置、TLS、内存映射、临时票据和进程退出处理。
- `src/core/session.ts`：waiting/ready/closed、双端 start、角色唯一性和幂等清理。
- `src/core/forwarding.ts`：方向计数、真实发送边界 ACK、窗口、速率桶及应用/原生共享缓冲预算。
- `relay-protocol`：listen/connect/attach/start/cancel 和相应控制消息的严格编码类型与解析。
- 公共包与核心保持可移植；新增独立 core/runtime 类型检查和核心导入边界检查。

桌面保留一个随机入口密钥，服务以其摘要定位在线入口，App 只保存入口与 targetId。
每次请求创建新的临时会话，桌面 ticket 用后失效，App 角色绑定原请求 socket。
所有服务端状态在有界内存中；没有设备档案、业务数据库、账号会话或独立授权后端。
数据 socket 继续承载现有 Noise；Relay 不批准业务权限、不解析或重放密文。

## 2. 已执行验证

环境：Bun 1.4.4 / macOS arm64。执行 `bun run verify` 通过：

- 包构建、五组类型检查、Bun 格式检查、Biome lint 与包/core 导入边界检查。
- 共 55 个测试通过，包含 R1 的协议和客户端回归。
- 两个 tarball 的离线消费者安装、无 Bun 全局类型检查、运行时导入及浏览器 bundle。

R2 用真实 runtime 验证的链路：

- WSS 使用正常证书验证，完成会合、Noise、双向业务记录和 1 MiB 二进制上传。
- 错误远端 Noise 身份被拒绝；错误 session/epoch/ticket、重放及重复接入不能替换合法对端。
- 提前 DATA、非法帧、错误 ACK、容量耗尽、缺少 ACK、超时及取消都能清理相关会话。
- 暂停真实 socket 读取，并在未读取时返还 ACK，仍触发原生/应用缓冲限制；回收后预算归零。
- 重启使旧票据失效，保留的 hostKey 恢复相同 targetId，再次建立通道。
- 迟到 cancel 不误关在线入口；循环建连清理映射和缓冲；排空保留 ready 流直到期限。
- 实际 `bun start` 对应的入口可启动、响应健康检查，并在 SIGTERM 后退出。

核心测试另外确定性覆盖 native send=-1 不重发、send=0 不算发送成功、尚在应用队列中的 DATA
不能被提前 ACK，以及原生缓冲在实际关闭前仍占用预算。

## 3. 仍待交付

后续已实现桌面/App 的邀请、连接 owner 与地址持久化接入，见[客户端接入记录](client-integration-status.md)。
本页的 55 个测试是 R2 交付时的记录；新增公共会合 helper 后本仓库为 61 个测试。
实际产品仍需完成跨网配对批准、已配对重连、撤销、手机换网和前后台验收。

Docker/Compose、公开许可证与依赖发布整理、Linux/容器/云部署验证属于后续自建交付。
这次没有执行 GitHub Actions、发布 npm 包或部署公网服务。
默认容量尚未做生产负载测试，R1 回环性能基线也不能视为这份 runtime 的云容量或费用。
用户策略、后台推送、P2P 与媒体继续按独立需求推进。
