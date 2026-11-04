# Docker 自建

需要 Docker Engine 和 Compose v2.24 或更高版本。以下命令均在仓库根目录执行。
一个域名只连接一个 Relay runtime；无需账号服务、数据库或持久卷。
镜像使用 Bun 1.4.4，从源码打包 protocol 和 runtime，不依赖 npm 上的未发布包。

## 本机验证 / 已有反向代理

```sh
docker compose -p cherry-relay \
  -f deploy/docker/compose.yml -f deploy/docker/compose.local.yml up -d --build
curl --fail http://127.0.0.1:8787/readyz
```

仅发布 `127.0.0.1:8787`，适合本机验证或宿主机上的 TLS 代理。基础 `compose.yml`
只声明容器网络中的端口；必须选用 local、Caddy 或 Tunnel 入口之一。
已有代理转发 `/v1/relay` 的 WebSocket upgrade 和 `/healthz`、`/readyz`，不要缓存、
缓冲或改写 WebSocket 帧，不要把这些连接按客户端 IP 分发到不同 Relay 副本。
代理闲置超时建议至少 180 秒，保留 WS ping/pong；runtime 自带心跳。
runtime 不使用 `X-Forwarded-For` 做授权或配额判断，现有限流按实例和连接计算。

单独构建和运行也可以：

```sh
docker build -f deploy/docker/Dockerfile -t cherry-relay:local .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=512m --pids-limit=128 --stop-timeout=30 \
  -p 127.0.0.1:8787:8787 cherry-relay:local
```

默认镜像使用非 root 用户和 exec 形式启动，Bun 直接收到 SIGTERM。
TLS 在代理终止；容器内使用 HTTP/WS，不要在这组模板中另设 `RELAY_TLS_CERT/KEY`。

## 公网 HTTPS / WSS（Caddy）

准备指向服务器的 DNS A/AAAA 记录，并允许入站 TCP 80、443。示例：

```sh
export RELAY_DOMAIN=relay.example.com
export ACME_EMAIL=ops@example.com
docker compose -p cherry-relay \
  -f deploy/docker/compose.yml -f deploy/docker/compose.caddy.yml up -d --build
```

Caddy 自动获取和续期证书，证书数据保存在 `caddy_data` 卷中。
客户端使用 `wss://relay.example.com/v1/relay`。不需要对外开放 8787。
默认不记录访问日志，避免记录客户端元数据；runtime 仅输出启动和关闭汇总。

## 配置、检查与升级

可复制 `deploy/docker/runtime.env.example` 为同目录的 `runtime.env`，再按
[runtime 配置](../../docs/runtime.md)调整连接、速率和缓冲限制。
Compose 固定监听 `0.0.0.0:8787`；`RELAY_LOCAL_PORT` 仅改变 local 模板的宿主机端口。
`RELAY_MEMORY_LIMIT`（默认 512m）、`RELAY_CPUS`（默认 1.0）控制容器资源。
这些是起始限制，不是生产容量保证；提高连接数时需同时测量内存、CPU 和转发流量。

```sh
bun install --frozen-lockfile
bun run build
bun run smoke:relay wss://relay.example.com/v1/relay
```

smoke 使用随机临时 host key，检查健康、三连接会合、双向各 1 MiB 原始二进制 DATA/ACK
及正常关闭，不访问 Cherry 账号或私有 API。它不能替代产品端 Noise 配对及真机验收。
仅本机允许 `ws://127.0.0.1:8787/v1/relay`；公网必须使用有效证书。

`/healthz` 表示进程存活，Docker HEALTHCHECK 使用它；`/readyz` 在排空时返回 503。
Docker 本身不会因为 unhealthy 自动重启容器，持续故障需要监控处理。
SIGTERM 会停止新会合、关闭 listener/等待中的连接，再等待已就绪会话，默认最多 10 秒。
`RELAY_DRAIN_MS` 加关闭宽限必须小于 Compose 的 `stop_grace_period: 30s`。

升级时用固定 Git commit 构建并保留旧镜像。先构建新镜像，再停止旧 Relay，最后启动新 Relay；
沿用同一个 Compose 项目名和入口文件。这个单实例版本有短暂中断，不做双副本滚动升级。
客户端重连后重新会合，旧 ticket/epoch 不复用，也不自动重放中断的业务操作。
回滚改用旧 `RELAY_IMAGE` 并通过 `up -d --no-build` 启动，不删除 Caddy 卷。
停止服务使用相同 `-f` 参数执行 `stop`；不要为了升级执行 `down -v`。

可用 Buildx 构建两种架构（`--push` 的目标仓库由部署者提供）：

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f deploy/docker/Dockerfile -t YOUR_REGISTRY/cherry-relay:YOUR_COMMIT --push .
```

仓库尚未发布官方容器镜像；`cherry-relay:local` 是本地构建标签。
更换服务器或使用云负载均衡时，仍必须保证 listener/connect/attach 到达同一实例。
验证范围见[部署记录](../../docs/deployment-status.md)。
