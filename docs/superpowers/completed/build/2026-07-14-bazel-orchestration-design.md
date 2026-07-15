# Bazel 统一构建入口设计

**日期：** 2026-07-14  
**状态：** 已确认

## 目标

把仓库中仅作为占位的 Bazel 配置补充为可执行的统一构建入口，覆盖 TypeScript workspace 的构建、检查和测试，以及桌面端的 sidecar 构建、Rust 检查和 Rust 测试。

本次不把现有 pnpm、Turborepo、Bun、Cargo、Next.js 和 Tauri 构建迁移为原生 Bazel rule。Bazel 负责提供稳定、可发现的仓库级命令入口；各生态工具仍负责实际构建。

## 命令接口

根 `BUILD.bazel` 暴露以下可通过 `bazel run` 执行的目标：

- `//:build`：构建除 desktop 外的 workspace；
- `//:lint`：检查除 desktop 外的 workspace；
- `//:typecheck`：类型检查除 desktop 外的 workspace；
- `//:test`：执行当前根级非桌面测试入口；
- `//:desktop-sidecar`：构建桌面端 server sidecar；
- `//:desktop-check`：执行桌面 Rust crate 检查；
- `//:desktop-test`：执行桌面 Rust crate 测试。

这些目标名称直接反映现有 CI 阶段，不增加会混淆平台边界的单一 `//:ci` 目标。Linux quality job 运行前四个目标；macOS desktop job 运行后三个目标。

## 实现结构

`bazel/run-task.sh` 是唯一命令适配器。它从第一个参数读取固定任务名，通过显式 `case` 映射到现有 pnpm 命令。未知任务或多余参数立即失败，避免 Bazel target 成为任意命令执行入口。

脚本使用 Bazel 为 `bazel run` 提供的 `BUILD_WORKSPACE_DIRECTORY` 回到真实 workspace，再调用宿主机已有的 `pnpm`。因此生成物仍位于当前 Turbo、Next.js、TypeScript 和 Cargo 约定的位置，行为与现有命令一致。

根 `BUILD.bazel` 为每个任务声明一个 `sh_binary`，复用同一适配器并传入固定参数。`.bazelversion` 固定 CI 与开发环境的 Bazel 版本；`.bazelrc` 保留 Bzlmod，并补充适合仓库入口的通用设置。

## 工具链与隔离边界

执行 Bazel 目标前仍需完成 `pnpm install --frozen-lockfile`，并安装 Node.js、pnpm、Bun；桌面目标还需要 Rust 与平台相关的 Tauri 依赖。Bazel 不下载或替代这些工具链。

这些目标是非 hermetic 的 orchestration targets：它们会读取 workspace 的 `node_modules`，并写入源码树下既有输出目录。文档必须明确这一点，不承诺 Bazel remote execution 或 action cache。未来若迁移到 `rules_js`、`rules_rust` 或专用 Tauri rule，应新增原生目标并逐项替换，而不是悄然改变当前入口语义。

## 错误处理

适配器启用严格 shell 模式。缺少 `BUILD_WORKSPACE_DIRECTORY`、缺少 `pnpm`、任务名未知或底层命令失败时，目标以非零状态退出，并保留底层命令输出。

`NEXT_PUBLIC_API_BASE_URL` 不在脚本中写死；构建目标继续接收调用环境或 CI 设置的值，与当前 Next.js 构建行为保持一致。

## 测试与验收

先为适配器编写独立 shell 测试，通过临时 mock `pnpm` 验证：

1. 每个固定任务映射到正确命令；
2. 未知任务、多余参数、缺失 workspace 环境和缺失 pnpm 会失败；
3. 底层命令失败状态会被传递。

测试先在适配器不存在或行为缺失时出现预期失败，再实现最小脚本使其通过。随后验证 Bazel target 可被查询；若本机没有 Bazel，则通过固定版本的 Bazelisk 或 CI 完成真实 `bazel run` 验证，并明确记录本地验证限制。

CI 在现有依赖安装步骤之后改用 Bazel 入口，保留 Linux quality 与 macOS desktop 的平台拆分。README 与 `bazel/README.md` 记录安装前提、命令示例和非 hermetic 边界。

## 非目标

- 不引入 `rules_js`、`rules_rust` 或新的依赖锁定体系；
- 不改变现有 package script 的行为；
- 不把开发服务器或生产常驻进程包装为 Bazel 目标；
- 不实现 remote cache、remote execution 或跨平台 Tauri 打包；
- 不顺带重构现有 Turbo pipeline。
