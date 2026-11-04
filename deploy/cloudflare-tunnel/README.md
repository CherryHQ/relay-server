# Cloudflare Tunnel 入口

使用同一个 Bun 容器，加一个 `cloudflared` 容器建立出站 Tunnel。
适合没有公网 IP、无法开放入站端口的服务器。它是公网 WSS 入口，不是 Workers/Durable Objects runtime。
不需要部署 Cherry 账号服务、数据库或 Cloudflare Access 登录页。

## 配置

1. 按 [Cloudflare 官方步骤](https://developers.cloudflare.com/tunnel/get-started/)创建 remotely-managed tunnel。
   需要 Cloudflare 账号和可配置的域名。保留该 Tunnel 的 token，仅放在服务器上的私密文件中，
   不放入仓库、Compose 文本、命令参数或日志。
2. 为 Tunnel 配置一个 published application，例如 `relay.example.com`，service 选择 **HTTP**，
   URL 为 **`relay:8787`**（即 `http://relay:8787`）。不要填写 `localhost`：connector 与 runtime 在不同容器。
   该主机名的所有路径交给同一个 service；不要使用路径规则或多副本把三条 WS 连接分散。
3. 确保 WebSockets 已开启，且此专用主机名没有交互式 Access、浏览器 challenge 或缓存规则阻挡
   `/v1/relay`、`/healthz`、`/readyz`。桌面/App 无法完成浏览器登录 challenge。
4. 在仓库根目录运行：

```sh
export TUNNEL_TOKEN_FILE=/absolute/private/path/relay-tunnel-token
docker compose -p cherry-relay \
  -f deploy/docker/compose.yml -f deploy/cloudflare-tunnel/compose.yml up -d --build
```

token 文件只包含 token 原文。固定版本的 `cloudflared` 镜像使用 UID/GID `65532:65532`；
本地 Compose 的 file secret 是 bind mount，不会自动修正宿主文件的 owner/mode。
Linux 服务器可用下面的方式把已有 token 文件复制到独立位置：

```sh
sudo install -d -m 0700 /etc/cherry-relay
sudo install -o 65532 -g 65532 -m 0400 /private/source/token /etc/cherry-relay/tunnel-token
export TUNNEL_TOKEN_FILE=/etc/cherry-relay/tunnel-token
```

在 Docker Desktop 上，按其文件共享规则确保容器 UID 可读取挂载文件。
请使用绝对路径；所有 Compose 相对路径都以第一个文件 `deploy/docker/compose.yml` 为基准。
模板通过 Docker secret 挂载为 `/run/secrets/tunnel_token`，使用官方
[`--token-file`](https://developers.cloudflare.com/tunnel/reference/run-parameters/) 参数。

没有任何宿主机端口映射。容器需要出站网络；防火墙需允许 cloudflared 的 TCP/UDP 7844。
Cloudflare 在边缘终止公网 TLS，connector 到同一 Docker 网络中的 Relay 使用 HTTP/WS。
客户端仍使用 `wss://relay.example.com/v1/relay`；业务密文的 Noise 加密保持在桌面/App 两端。

## 验收、运行与故障

确认 Cloudflare Dashboard 显示 Tunnel Healthy，再检查真实公网入口：

```sh
curl --fail https://relay.example.com/readyz
bun install --frozen-lockfile
bun run build
bun run smoke:relay wss://relay.example.com/v1/relay
```

smoke 检查真实会合及双向二进制转发。Dashboard 的 Tunnel Healthy 只证明 connector 连上边缘，
不能证明 runtime、DNS 或转发路径正确；容器 health 也不能代替公网验收。
cloudflared 的 metrics/ready 服务监听容器内 2000，未发布到宿主机或公网。
token 轮换后按官方流程更新文件并重建 connector；不要在排查输出中打印 token。

保持 **一个 Relay 实例、一个 connector**。不能把同一 Tunnel 的 connector 副本部署到
各自独立的 Relay 上：Cloudflare 不保证两端到达同一个内存会话表。
不要用 `docker compose --scale relay=2` 扩容；需要多实例时另行实现同会话寻址。
Cloudflare 或网络重启可能中断 WebSocket，端点重新会合；不保证已建立会话无中断迁移。

升级时先构建，随后停止 connector，再停止/启动 Relay，确认健康后启动 connector。
停 connector 会中断现有会话；这是明确的维护窗口，避免新旧 Relay 同时接收同一域名。
资源和重启规则见 [Docker 部署](../docker/README.md)。
当前验证范围及公网待验项见[部署记录](../../docs/deployment-status.md)。
