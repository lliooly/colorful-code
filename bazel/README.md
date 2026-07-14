# Bazel 任务入口

Bazel 为仓库中的常用检查和构建任务提供统一入口，实际工作仍由 pnpm、Turborepo、Bun 和 Cargo 完成。

## 环境准备

使用这些目标前，请准备以下宿主工具：

- Node.js 22
- pnpm 11
- Bun
- Rust stable（仅桌面端目标需要）
- Bazelisk（推荐，会读取 `.bazelversion`）或 Bazel

先在仓库根目录安装依赖：

```bash
pnpm install
```

仓库根目录的 `.bazelversion` 当前固定为 Bazel 9.1.0。

## 目标矩阵

| Bazel 目标           | 对应任务                                                      | 说明                         |
| -------------------- | ------------------------------------------------------------- | ---------------------------- |
| `//:lint`            | `pnpm turbo run lint '--filter=!@colorful-code/desktop'`      | 检查非桌面端 workspace       |
| `//:typecheck`       | `pnpm turbo run typecheck '--filter=!@colorful-code/desktop'` | 检查非桌面端 TypeScript 类型 |
| `//:build`           | `pnpm turbo run build '--filter=!@colorful-code/desktop'`     | 构建非桌面端 workspace       |
| `//:test`            | `pnpm run test`                                               | 运行非桌面端测试             |
| `//:desktop-sidecar` | `pnpm --filter @colorful-code/desktop build:server-sidecar`   | 构建桌面端 Server sidecar    |
| `//:desktop-check`   | `pnpm --filter @colorful-code/desktop lint`                   | 检查 Rust crate              |
| `//:desktop-test`    | `pnpm --filter @colorful-code/desktop test`                   | 测试 Rust crate              |

例如：

```bash
bazel run //:lint
bazel run //:typecheck
bazel run //:build
bazel run //:test

bazel run //:desktop-sidecar
bazel run //:desktop-check
bazel run //:desktop-test
```

## 设计边界

这些目标是非 hermetic 的编排层。它们从 Bazel 启动后回到当前 workspace，读取已经安装的 `node_modules` 和宿主工具链，并把产物写入 Turborepo、Next.js、TypeScript 与 Cargo 现有的输出目录。因此，当前入口不承诺 Bazel remote cache 或 remote execution。

`rules_shell@0.8.0` 是这些 Bazel 9 launcher 唯一的 Bzlmod 依赖，用于声明 Shell 入口；`MODULE.bazel.lock` 会随仓库提交，以固定解析结果。

`dev`、`start:prod` 等常驻进程不会包装成 Bazel 目标，仍请使用现有 pnpm 命令启动。

适配器会透传底层命令的标准输出、标准错误、退出状态和运行时环境。通过 `bazel run` 启动时，运行时变量由 Bazel 运行命令继承，再由适配器传给 pnpm；例如：

```bash
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 bazel run //:build
```

仓库的 `.bazelrc` 通过 `run --action_env=NEXT_PUBLIC_API_BASE_URL` 让构建 action 读取调用方显式设置的值；它不是适配器运行时环境继承的来源。
