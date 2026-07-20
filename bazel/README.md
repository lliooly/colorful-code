# Bazel 构建边界

Bazel 在仓库中承担两类职责：

- `//packages/schema:contract_codegen` 是只读取声明输入、只写入 Bazel output tree 的 hermetic schema action。
- 根目录的常用检查和构建目标是宿主 orchestration 入口，实际工作仍由 pnpm、Turborepo、Bun 和 Cargo 完成。

## 环境准备

使用宿主 orchestration 目标前，请准备以下工具：

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

Schema codegen 目标不使用宿主 Node.js、pnpm、Bun 或 `node_modules`。`MODULE.bazel` 为它固定 Node.js 22.22.0，并由 `aspect_rules_js` 根据根目录的 `pnpm-lock.yaml` 解析 npm graph。`pnpm-lock.yaml` 是 Bazel JavaScript/TypeScript 依赖版本的唯一解析来源；不维护第二份 npm lockfile。

## 目标矩阵

| Bazel 目标                                 | 对应任务                                                      | 说明                         |
| ------------------------------------------ | ------------------------------------------------------------- | ---------------------------- |
| `//:lint`                                  | `pnpm turbo run lint '--filter=!@colorful-code/desktop'`      | 检查非桌面端 workspace       |
| `//:typecheck`                             | `pnpm turbo run typecheck '--filter=!@colorful-code/desktop'` | 检查非桌面端 TypeScript 类型 |
| `//:build`                                 | `pnpm turbo run build '--filter=!@colorful-code/desktop'`     | 构建非桌面端 workspace       |
| `//:test`                                  | `pnpm run test`                                               | 运行非桌面端测试             |
| `//:desktop-sidecar`                       | `pnpm --filter @colorful-code/desktop build:server-sidecar`   | 构建桌面端 Server sidecar    |
| `//:desktop-check`                         | `pnpm --filter @colorful-code/desktop lint`                   | 检查 Rust crate              |
| `//:desktop-test`                          | `pnpm --filter @colorful-code/desktop test`                   | 测试 Rust crate              |
| `//packages/schema:contract_codegen`       | 原生 Bazel schema codegen                                     | 生成 4 个声明输出            |
| `//packages/schema:contract_codegen_check` | 逐字节 fixture drift check                                    | 检查 4 个已提交产物          |

例如：

```bash
bazel run //:lint
bazel run //:typecheck
bazel run //:build
bazel run //:test

bazel run //:desktop-sidecar
bazel run //:desktop-check
bazel run //:desktop-test

bazel build //packages/schema:contract_codegen
bazel test //packages/schema:contract_codegen_check
```

## Hermetic schema action

`contract_codegen` 在 Bazel sandbox 中编译并运行纯生成内核，不调用会管理锁、transaction、staging 和原子发布的源码树入口。它分别声明四个输出：

- `openapi.v2.json`
- `events.schema.json`
- `contracts.ts`
- `ColorfulCodeContracts.swift`

`contract_codegen_check` 将这四个 Bazel 输出与仓库中已提交的 OpenAPI、event schema、TypeScript 和 Swift fixture 逐字节比较。它只报告 drift，不修改工作区。开发者需要更新已提交产物时，仍使用 `pnpm --filter @colorful-code/schema schema:generate`，由源码树发布器维持现有锁和原子替换语义。

该 action 的声明输入、工具链和命令行构成本地 action cache key。本阶段只依赖 Bazel 默认本地缓存，不承诺 remote cache、remote execution 或跨平台 cache hit；后三者需在输出字节稳定性和 action key 边界独立验证后再启用。

## 宿主 orchestration 边界

这些目标是非 hermetic 的编排层。它们从 Bazel 启动后回到当前 workspace，读取已经安装的 `node_modules` 和宿主工具链，并把产物写入 Turborepo、Next.js、TypeScript 与 Cargo 现有的输出目录。因此，当前入口不承诺 Bazel remote cache 或 remote execution。

`rules_shell@0.8.0` 用于声明这些 Shell 入口；`MODULE.bazel.lock` 会随仓库提交，以固定 Bzlmod 解析结果。

`dev`、`start:prod` 等常驻进程不会包装成 Bazel 目标，仍请使用现有 pnpm 命令启动。

适配器会透传底层命令的标准输出、标准错误、退出状态和运行时环境。通过 `bazel run` 启动时，运行时变量由 Bazel 运行命令继承，再由适配器传给 pnpm；例如：

```bash
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 bazel run //:build
```

仓库的 `.bazelrc` 通过 `run --action_env=NEXT_PUBLIC_API_BASE_URL` 让构建 action 读取调用方显式设置的值；它不是适配器运行时环境继承的来源。

## Telemetry

`.bazelrc` 固定 `common --repo_env=ASPECT_TOOLS_TELEMETRY=-all`，对 Aspect Bazel 工具的 telemetry 选择退出。CI 和本地 Bazel 命令都会读取该设置。
