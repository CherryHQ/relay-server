# 部署交付与验证记录

日期：2026-11-04。已完成 Docker、Cloudflare Tunnel 和独立 Workers/DO 适配；Vercel 暂缓。

## 交付内容

- [Docker](../deploy/docker/README.md)：多阶段构建，固定 Bun 基础镜像 digest，直接从源码打包，
  无 npm 运行依赖；非 root、只读文件系统、健康检查、资源限制和 SIGTERM 排空。
- [Caddy](../deploy/docker/compose.caddy.yml)：公网 TLS 入口与证书卷；已有代理可使用 loopback 入口。
- [Cloudflare Tunnel](../deploy/cloudflare-tunnel/README.md)：固定 connector 镜像，文件 secret、
  connector readiness、独立资源限制，不开放宿主机端口；业务认证仍归桌面/App。
- `bun run smoke:relay URL`：健康、三连接会合、双向各 1 MiB DATA/ACK 和关闭验证。
- `bun run check:container IMAGE` 与容器 CI：非 root、只读运行、二进制转发、SIGTERM 和重启检查。
- [Workers + Durable Objects](../deploy/cloudflare/README.md)：每部署一个 DO，多个设备/会话共用；
  attachment 恢复在线状态，alarm 清理期限，随机收包回执约束发送缓冲。提供 dry-run 与独立 workerd CI。

没有发布官方容器镜像，也没有新增账号服务、业务数据库、消息存储或跨实例 broker。
DO 仅使用 socket 附属状态和 alarm。
每个部署入口仍要求只有一个会话 owner（Bun 进程或固定 DO），不宣称跨 owner 透明迁移。

## 已运行的检查

| 检查                    | 结果与范围                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根工程 `bun run verify` | 73 项测试通过，构建、类型检查、格式、lint、离线包消费者检查通过                                                                                                                        |
| Linux ARM64 镜像        | 在隔离 Colima/Docker 环境实际运行；非 root、只读、health、双向各 1 MiB、正常关闭、SIGTERM 退出码 0 和重启后再次会合通过                                                                |
| Linux AMD64 镜像        | 交叉构建通过；本机 QEMU 运行时缺少 AVX，Bun HEALTHCHECK 崩溃，未记为运行通过                                                                                                           |
| Compose                 | local、Caddy、Tunnel 三组组合均通过 `config --quiet`                                                                                                                                   |
| Caddy                   | 实际镜像通过配置校验；本机 HTTP 反向代理入口的健康、会合、双向各 1 MiB 和关闭通过                                                                                                      |
| Cloudflare 数据路径     | 临时 Quick Tunnel 经真实公网 WSS 完成同一 smoke；connector readiness 检查通过；测试后关闭临时入口                                                                                      |
| Workers/DO 打包         | Wrangler dry-run 通过                                                                                                                                                                  |
| Workers/DO 本地执行     | workerd 完成双向各 1 MiB DATA/ACK；强制休眠后 constructor 重跑，原 socket/epoch 保留，票据重放和伪造 ACK 被拒绝；同一 Noise 通道跨休眠完成 1 MiB 上传和反向响应；关闭后连接与预算归零  |
| Workers/DO 生产入口     | 已部署到 CherryAI 账号的 <https://cherry-relay.cherryai.workers.dev>；公网健康检查、会话会合、双向各 1 MiB DATA/ACK 和关闭流程通过                                                     |
| Workers/DO 自动部署     | `main` 已连接 Cloudflare Workers Builds，验证成功后发布；命令和构建变量见 [Workers 部署说明](../deploy/cloudflare/README.md#github-自动部署)，每次执行结果以对应提交的云端构建记录为准 |

AMD64 的本机失败属于已观察到的模拟环境限制：Bun 报告 `CPU lacks AVX support`，
不能据此宣布 AMD64 运行验证成功或忽略失败。已加入 `ubuntu-latest` 原生 AMD64 容器 CI，
此表记录推送前完成的本地验证；原生 AMD64 的运行结果以对应提交的远程 workflow 为准。

临时 Tunnel 仅验证本次网络条件下的 Cloudflare WSS 数据路径；它没有验证正式命名 Tunnel 的
token、DNS、Access/WAF 配置或长期可用性。Caddy 本机测试没有申请公网 ACME 证书。
smoke 使用生成的测试字节，不是吞吐量基准，也不证明客户端 Noise 配对和真机生命周期已验收。

## 下一步验收

1. 在原生 AMD64 runner 上完成容器 CI，再发布与源码 commit 对应的多架构镜像。
2. 部署正式 Caddy 域名或命名 Tunnel，运行公网 smoke，验证续期/重启/排空及监控。
3. 接入桌面与 App，完成跨网配对、配置导入、换网、前后台恢复及撤销测试。

生产容量和费用按实际连接驻留、出口流量、CPU/内存测量，不从上述 smoke 推导。

## EdgeOne 原生托管评估（2026-11-05）

用户选定完整 EdgeOne 托管、不保留源站。已核对 Node Functions WebSocket 示例、Agents 会话
亲和文档及 CLI 1.6.47 的两套运行入口；尚未证明 Agents 能同时承载 Relay 所需的三条 WebSocket。
最小本地验证在 CLI 认证阶段被阻挡，未形成运行或部署通过记录。具体差异、验证步骤和适配范围见
[EdgeOne 原生托管评估](edgeone-native-hosting.md)。当前不列入已支持的部署方式。
