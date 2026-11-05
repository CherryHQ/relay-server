# Cherry Relay

为 **Cherry Studio 桌面端与 Cherry Studio App** 提供 WSS 中转。两端主动连接同一 Relay，
复用现有 MessageStream、Noise、设备配对与业务协议。

首版只负责 **会话会合、密文转发、背压限流和断线清理**。
设备身份、配对批准和业务权限由端点处理；runtime 独立于用户凭证服务。
基础运行无需账号登录、设备登记库、独立管理后端或计费系统。
同一会话的两端必须到达同一个 runtime，混合云适配范围仅限 runtime。

已实现两个跨端包和单实例 Bun runtime：临时会合、二进制转发、有界 RelayStream 和运行资源保护。
真实 runtime 的 Noise/WSS、1 MiB 上传、异常接入、重启和慢读清理已通过本地验证。
桌面/App 接入代码与本地回归已实现；原生端到端验收及依赖发布仍待完成。
已提供 [Docker / Caddy](deploy/docker/README.md)、[Cloudflare Tunnel](deploy/cloudflare-tunnel/README.md)
及支持休眠恢复的 [Workers + Durable Objects](deploy/cloudflare/README.md)
部署配置，验证范围见[部署记录](docs/deployment-status.md)。Vercel 暂缓。
EdgeOne 按[无源站原生托管目标](docs/edgeone-native-hosting.md)验证平台能力，尚未支持部署。
详见[客户端接入记录](docs/client-integration-status.md)和[R2 实现记录](docs/r2-implementation-status.md)。
桌面与 App 草稿使用未发布的本地包，准备步骤见[客户端草稿联调](docs/client-preview.md)。

开发工具链使用 Bun 1.4.4：

```sh
bun install --frozen-lockfile
bun run build
bun start
```

默认监听 `127.0.0.1:8787`，提供 `/v1/relay`、`/healthz` 和 `/readyz`。
TLS、资源配置及会合流程见[运行说明](docs/runtime.md)。本地验证：

```sh
bun run verify
```

`verify` 包含构建、类型检查、格式、lint、测试和离线打包消费者检查。
包检查先为隔离消费者解析依赖，再清空安装目录验证离线重装；首次运行需要访问包注册表。
测试需要系统 `openssl` 和 `tar`；格式化使用 `bun run format`。
`bun run perf:baseline` 输出本机回环基线，不代表生产容量或云端费用。

容器本机启动（仅绑定 loopback）：

```sh
docker compose -p cherry-relay \
  -f deploy/docker/compose.yml -f deploy/docker/compose.local.yml up -d --build
bun run smoke:relay ws://127.0.0.1:8787/v1/relay
```

公网入口选择上面的 Caddy 或 Cloudflare Tunnel 配置，客户端使用 WSS。
`bun run build:runtime` 可独立打包服务；`bun run check:container IMAGE` 检查已构建的镜像。
`bun run dev:cloudflare` 启动本地 DO；`bun run check:cloudflare` 使用 Node.js 24 + workerd 验证真实休眠恢复。
DO 入口需要本次更新后的客户端收包回执支持，接入步骤见上面的 Workers 部署说明。

文档按职责划分：

- [架构与范围](docs/architecture.md)：最小 runtime、状态归属和连接边界。
- [运行说明](docs/runtime.md)：启动、TLS、控制协议、资源配置与排空。
- [实施顺序](docs/delivery-plan.md)与[运行时实现方案](docs/implementation-plan.md)：当前契约和下一批验收。
- [文件组织](docs/repository-layout.md)：现有文件与职责。
- [P2P 数据直连方案](docs/p2p-implementation-plan.md)：端侧传输库、加密通道信令和可配置 STUN；Relay 服务端保持原样，P2P 尚未实现。
- [开源自建](docs/open-source-deployment.md)与[混合云适配](docs/hybrid-cloud-adapters.md)：部署和平台验证。
- [性能与后台推送](docs/performance-and-operations-plan.md)：资源限制、测量和可选通知能力。
- [可选用户策略接入](docs/saas-auth-integration-plan.md)：未来需要账号权益时的边界。

开源自建和官方托管复用相同协议。是否免费提供取决于实际成本，首版不建设套餐、用户余额或计费账本。
后台推送独立交付；P2P 数据直连按上述方案先验证两端库，媒体能力仍按实际需求评估。
