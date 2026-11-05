# EdgeOne 原生能力探测

当前交付的是临时验证工程，**还不是 Relay 部署适配器**，不提供 `/v1/relay`。
目标仍是全部运行在 EdgeOne，不保留源站。平台接口差异与后续验收条件见
[原生托管评估](../../docs/edgeone-native-hosting.md)。

## 构建与入口

在仓库根目录执行：

```sh
bun run build:edgeone-probe
```

产物位于 `dist/edgeone-probe/`，可以作为独立 Makers 工程使用：

```text
edgeone.json
package.json
public/index.html
cloud-functions/probe/cloud.js  → /probe/cloud
agents/probe/agent.js           → /probe/agent
```

构建使用 Bun，产物使用 Node.js 和标准 Web API。独立工程声明 `ws@8.22.1`：
CLI 1.6.47 生成的 Cloud Functions wrapper 在 WebSocket 升级时需要此依赖。
它不进入 Relay 协议包、客户端或其他部署适配器。
Node 20 与 `agents` 配置已经过 `edgeone@1.6.47 validate` 检查。
两个入口返回同一种 `websocket` 回调对象；这是已核对的 Cloud Functions 形式，
**在 Agents 上是否被接受正是要探测的条件**。Agent 的普通请求对象会单独转换请求头，
不会把它误当成标准 `Request`。

## 认证与本地平台验证

EdgeOne CLI 本地开发也要求登录。使用你自己的 Makers 账户执行：

```sh
cd dist/edgeone-probe
bun install --ignore-scripts
bunx --package edgeone@1.6.47 edgeone login
bunx --package edgeone@1.6.47 edgeone makers dev --port 8839 --skip-env-sync --skip-ai-gateway-sync
```

无交互环境使用 Makers 控制台创建的短期 API Token，通过 `EDGEONE_PAGES_API_TOKEN`
注入进程环境。腾讯云 SecretId/SecretKey 不是此 CLI 的 Makers Token；不要把凭证写入
代码、部署产物或命令日志。使用专门的测试项目，若 CLI 要求关联项目，应明确选定该项目；
项目名参数在项目不存在时可能触发创建。

含 `agents/` 的工程必须关联 Makers 项目；上述两个跳过参数不能取消此要求。
若只验证 Cloud Functions，可以把构建产物的 `cloud-functions/`、`public/`、`package.json`
复制到一个独立临时目录，使用 `{"nodeVersion":"20","outputDirectory":"public"}` 作为
`edgeone.json`，安装依赖后运行相同开发命令。这种 raw mode 不验证 Agents 或云端调度。

然后在仓库根目录执行：

```sh
bun run check:edgeone-probe http://127.0.0.1:8839
```

本地检查脚本由 Bun 执行，使用其自定义 WebSocket 请求头能力。
这不会修改或证明移动端、桌面端的跨平台 socket factory 已支持该路由方式。

## 云端验证

### 控制台直接上传

若要先通过控制台验证项目创建和静态部署，可以上传最小验证包：

```sh
mkdir -p .context
zip -j .context/edgeone-upload-check.zip deploy/edgeone/upload-check/index.html
```

在 Makers 中选择「创建项目 → 直接上传」，填写项目名和加速区域，上传此 ZIP 后开始部署。
包内只有根目录的 `index.html`，不含凭证、函数或 Relay 服务；页面可访问仅说明静态部署通过，
不能证明 WebSocket 或三连接会合可用。若仍返回 `Zone is not active`，应继续排查账号资源状态。

[官方直接上传文档](https://pages.edgeone.ai/document/direct-upload)要求 `index.html` 位于
ZIP 根目录，平台不会执行依赖安装或构建，且此方式只支持 `edgeone.json` 中的重定向、重写和
响应头配置。文档列出了 `edge-functions/` 与 `cloud-functions/`，未列出 Agents 支持。
因此不要直接压缩整个仓库或 `dist/edgeone-probe/` 当作控制台部署包；完整探测工程按下面的 CLI
流程部署和验证。

### CLI 原生探测

选择账号下用于验证的直接上传项目，按 Makers CLI 流程部署此产物。例如在产物目录内：

```sh
bunx --package edgeone@1.6.47 edgeone makers deploy -n <test-project-name> -e preview
```

得到可供 CLI 直接连接的 HTTPS 域名后，在仓库根目录执行：

```sh
bun run check:edgeone-probe https://<test-host>
# 也可只检查一个入口
bun run check:edgeone-probe https://<test-host> cloud
bun run check:edgeone-probe https://<test-host> agent
```

如果默认预览地址要求浏览器校验或限时访问参数，应先解决该入口的访问条件；
CLI 拒绝把查询串、登录凭证或账户 Token 混入探测 URL。
不要把受保护预览入口的 401 当成 WebSocket 不受支持的证据。

探测仅发送随机测试字节。它没有生产认证、Noise 或业务会话能力；验证结束后撤下测试部署。

## 检查内容与限制

- 两个不同 `Makers-Conversation-Id` 的会话同时在线，每组分别建立 listener、app、desktop。
- 每组的三条连接必须报告相同实例启动标识，desktop 只能通过 listener 收到的一次性票据接入。
- 每个方向、每组传输 16 个 `64 KiB + 24` 字节二进制消息，并逐条校验完整内容；
  两组交错传输，串发、广播、转成文本或截断均会失败。
- app 断开时 desktop 关闭，listener 仍可应答；第一组 listener 关闭后第二组仍可转发。
- 普通 HTTP 200 JSON、SSE、握手失败、超时均不能作为成功结果。

探测每实例最多 4 组，每组存活 60 秒、最多接收 128 条消息和 4 MiB 二进制数据。
发送前检查 socket 原生待发送量，超过 1 MiB 预算关闭数据连接；没有额外应用发送队列。
这些是探测程序的保护上限，不是对平台接收缓冲、跨实例总量或生产背压的保证。

本地回环测试使用 Bun 作为回调测试宿主，覆盖票据隔离、延迟升级、过期与关闭行为。
它不模拟 EdgeOne 调度，不能证明云端亲和。即使云端某一批检查通过，仍需要平台提供
多连接会合的正式保证，并验证原生缓冲、连接期限、实例回收以及真实客户端路由。
上述检查不是吞吐量或成本基准。

## 已观察到的阻断

CLI 1.6.47 的 Cloud Functions wrapper 实现了 WebSocket 回调升级；Agents wrapper
走独立的 HTTP 响应路径，其 `normalizeHandlerResponse` 会将普通返回对象序列化为 JSON。
因此不能因两者使用相似 handler 就认定 Agents 接受 WebSocket。

2026-11-05 已用有效 Makers Token 启动 Cloud Functions 的真实 CLI 开发入口。
首次升级因缺少 `ws` 返回 500；补齐上述依赖后 listener WebSocket 握手成功，
随后同一会话的 app 连接返回 404，未找到 listener。该版本生成的代码在每个请求内
重新执行模块初始化，连续请求得到不同 `bootId`，因此模块内 Map 不能完成三连接会合。
这次原生检查明确失败，不把单条 WebSocket 成功记为 Relay 运行通过。

Agents 尚未完成原生运行：Token 可读取项目列表，但创建测试项目返回
`FailedOperation: Zone is not active`；`DescribePagesZones` 返回空列表。
这只能说明当前 Token 可见的账号资源状态，仍需结合控制台确认开通状态和访问权限。
上述问题与 Agents 的 WebSocket 返回契约分别记录，开通服务不能自动解决运行契约缺口。

相关官方资料：[CLI](https://pages.edgeone.ai/document/edgeone-cli)、
[API Token](https://pages.edgeone.ai/document/api-token)、
[Agents](https://pages.edgeone.ai/document/agents)。
