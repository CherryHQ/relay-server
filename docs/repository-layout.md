# 仓库文件组织

日期：2026-11-04。记录现有包、最小 runtime 和部署文件的职责。
首版范围见[架构](architecture.md)，不预建账号、管理后台、数据库或所有 vendor 的模块。

## 1. 已有文件

```text
relay-server/
├── package.json / bun.lock / .bun-version
├── tsconfig.base.json / tsconfig.tools.json / tsconfig.core.json / tsconfig.runtime.json
├── bunfig.toml / biome.json
├── packages/
│   ├── relay-protocol/
│   │   ├── src/                  # frame、ready、rendezvous、limits 及可选 proof 编码
│   │   ├── vectors/              # 固定帧与签名验证向量
│   │   ├── tests/
│   │   └── package.json / tsconfig.json / README.md
│   └── relay-client/
│       ├── src/                  # RelayStream、connect/attach 会合、socket 契约及可选签名 helper
│       ├── tests/
│       └── package.json / tsconfig.json / README.md
├── src/
│   ├── config.ts
│   ├── core/                    # session、forwarding、ports
│   ├── bun/                     # runtime、main
│   └── cloudflare/              # Worker/DO 入口、恢复、回执预算和平台限制
├── scripts/
│   ├── build-packages.ts
│   ├── build-runtime.ts          # 无 npm 运行依赖的服务 bundle
│   ├── check-imports.ts
│   ├── check-package.ts
│   ├── smoke-relay.ts            # 指定入口的健康、会合、双向二进制验证
│   ├── check-container.ts        # 非 root、只读、SIGTERM、重启验证
│   ├── check-cloudflare.ts       # Bun 客户端 + workerd 休眠/Noise 验证
│   └── cloudflare-host.mjs       # 仅供测试的 Node/Miniflare 驱动
├── deploy/
│   ├── docker/                   # Dockerfile、Compose、Caddy、环境示例及说明
│   ├── cloudflare-tunnel/        # connector Compose、secret 挂载及说明
│   └── cloudflare/               # Workers/DO Wrangler 配置与部署说明
├── tests/
│   ├── core/                     # 会话、计数、预算和配置
│   ├── bun/                      # 真实 runtime、WSS/Noise、入口和故障用例
│   ├── cloudflare/               # 状态清空、票据/流控/预算恢复及测试专用 Worker
│   ├── harness/                  # loopback WSS + 真实 Noise；仅供测试
│   └── performance/              # 本机诊断基线
├── .github/workflows/            # 代码/包验证和容器验证
└── docs/
```

根工程和两个包目前均标记 private，防止误发 npm；这不改变开源自建的交付目标。
公开包只导出 JS 与声明，测试转发器不进入产物。实现状态见[R2 记录](r2-implementation-status.md)。

## 2. R2 runtime 文件

以下文件已实现，核心规则与 Bun 的 socket/生命周期分离。

| 位置                        | 负责                                      |
| --------------------------- | ----------------------------------------- |
| `src/config.ts`             | 监听地址、TLS 文件、资源限制和超时配置    |
| `src/core/session.ts`       | 临时会合、角色接入、ready 与唯一关闭路径  |
| `src/core/forwarding.ts`    | 外层帧、顺序/ACK、速率和缓冲约束          |
| `src/core/ports.ts`         | 核心实际需要的发送、原生缓冲和关闭契约    |
| `src/bun/main.ts`           | 配置、单一服务入口、健康检查和排空        |
| `src/bun/runtime.ts`        | socket、内存会话表、回调、背压和期限回收  |
| `tests/core/`、`tests/bun/` | 会合规则、真实 socket、实例容量及故障清理 |

业务状态只有在线映射和临时会话，不规划 store、迁移、operator CLI 或配额账本。
共享核心定义会话规则，host 持有实际连接并保证同一会话的转换有序。
接口从真实消费者提取，不引入通用事件解释器、插件加载器或依赖注入框架。

`deploy/docker/` 和 `deploy/cloudflare-tunnel/` 已提供镜像构建与入口配置；
`.dockerignore` 只允许 runtime 构建输入，不把本地凭据、`.context` 或产品工作区送入构建。
Vercel 暂缓，没有创建占位 adapter。

## 3. 依赖与类型隔离

| 消费者                    | 允许的依赖                                                |
| ------------------------- | --------------------------------------------------------- |
| relay-protocol            | 可移植编码和类型                                          |
| relay-client              | protocol、现有 MessageStream 契约、注入的 socket/签名能力 |
| core                      | protocol、必要的运行时窄接口                              |
| Bun / 后续 vendor runtime | core 与该平台实际需要的 API                               |
| 桌面 / App                | 公开包及自身现有 remote-transport                         |

公共包和 core 不导入 Bun/Node/厂商 SDK，也不加载产品登录、数据库或业务 RPC。
客户端不负责业务重试，不另建 AppState 或连接 owner。
平台 SDK 声明在所属构建范围，按需引入，避免将所有 vendor 依赖装进客户端或 Bun 镜像。

`tsconfig.base.json` 的 `types: []` 隔离平台全局；Bun runtime、测试/脚本单独引入 Bun 类型。
`tsconfig.cloudflare.json` 单独检查 Workers 类型，平台 SDK 不进入公开包或 Bun bundle。
`check-imports.ts` 检查包的源码/声明及 core 的导入边界与平台全局；
`check-package.ts` 验证 tarball、离线消费者和浏览器构建。
类型检查与打包成功仍不能替代 Electron/Hermes 真机验证。

## 4. 后续文件的建立条件

[P2P 方案](p2p-implementation-plan.md#2-文件组织)放在 Desktop 仓库的 `remote-transport/p2p` 子入口，
由 Desktop/App 共享，原生适配器留在各产品。`remote-protocol` 只增加可选端侧能力声明；
信令在现有加密通道内传递。这里的两个 Relay 包、runtime 和部署不因 P2P 增加实现。
STUN 地址由客户端配置，自建仅提供可选指引，不预建 `deploy/stun/`。P2P 文件尚未创建。

同类云 VM/容器优先增加部署配置。出现第二种实际运行环境时，再增加其 runtime 入口和生命周期测试。
为满足平台休眠或寻址确有必要的状态由该适配器负责，不预建跨厂商持久存储接口。

用户策略和后台推送在需求明确后单独落地。通知投递数据归通知模块，账号数据归现有用户体系，
二者都不加入转发核心。目录和接口以实际采用的方案为准。
