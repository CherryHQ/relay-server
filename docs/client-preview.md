# 客户端草稿联调

桌面和 App 的 Relay 接入目前是 draft，尚未发布 Relay 包和含 QR v4 的 remote-protocol。
产品的 `file:.context/relay-packages/*.tgz` 指向本地预览包；这些文件被 Git 忽略。
因此，普通 clone 后直接安装或运行 CI 不能替代下面的准备步骤。正式合入前必须改为已发布版本，
删除临时 override 并重新生成 lockfile；本说明不授权发布包。

分别准备三个独立 checkout：本仓库，以及桌面和 App 对应 draft PR 的 head。
使用 Bun 1.4.4、Node 24 和各产品 `packageManager` 指定的 pnpm。
不要将产品 checkout 嵌套在 Relay 仓库下，以免祖先目录的 Bun 全局类型污染桌面的类型检查。

在 Relay checkout 安装、构建并打包：

```sh
bun install --frozen-lockfile
bun run build
mkdir -p .context/relay-packages
(cd packages/relay-protocol && bun pm pack --ignore-scripts --filename ../../.context/relay-packages/relay-protocol.tgz)
(cd packages/relay-client && bun pm pack --ignore-scripts --filename ../../.context/relay-packages/relay-client.tgz)
```

将两个 tarball 复制到桌面和 App 各自的 `.context/relay-packages/`。桌面先安装依赖、构建其
remote-protocol，再为 App 打包。下列 `APP_CHECKOUT` 替换为 App checkout 的绝对路径：

```sh
APP_CHECKOUT=/absolute/path/to/cherry-studio-app
pnpm install --no-frozen-lockfile
pnpm --filter @cherrystudio/remote-protocol build
pnpm --filter @cherrystudio/remote-protocol pack --out "$APP_CHECKOUT/.context/relay-packages/remote-protocol.tgz"
```

随后在 App checkout 执行 `pnpm install --no-frozen-lockfile`。
本地重建 tarball 的内容或打包器版本可能改变 integrity，因此预览准备允许刷新 lockfile；
检查并只保留相关包的变化，不要提交不相关的依赖升级。

两端继续运行各自的相关测试。App 新增 `relay-socket` 原生模块，必须重新构建 native client，
不能仅发 OTA。当前编译、测试和设备验证边界见[接入记录](client-integration-status.md#3-验证与剩余边界)。
