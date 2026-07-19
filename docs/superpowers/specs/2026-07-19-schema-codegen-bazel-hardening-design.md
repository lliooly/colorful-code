# Schema Codegen Bazel Hardening 设计

**日期：** 2026-07-19

**状态：** 已确认

**实施窗口：** Phase 0B-8 验收后、Phase 0B-9 开始前

## 1. 背景

Phase 0B-8 已从同一套 Zod authoring source 确定性生成以下公共 Contract 产物：

- `packages/schema/generated/openapi.v2.json`；
- `packages/schema/generated/events.schema.json`；
- `packages/schema/generated/typescript/contracts.ts`；
- `packages/schema/swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift`。

现有 `packages/schema/scripts/generate.ts` 同时承担两类职责：

1. 从 Contract registry 和 emitter 计算确定的输出内容；
2. 在源码树中执行互斥、staging、事务日志、故障恢复和原子发布。

第二类职责适合开发者主动更新已提交产物，但不适合作为 Bazel build action。Bazel action 已在隔离的输出目录中执行，只应读取声明的输入并写入声明的输出。若直接包装现有命令，action 会依赖 Bun FFI、宿主文件系统状态、PID、hostname 和随机 nonce，无法形成可靠的 action key，也难以安全复用缓存。

本 hardening 在不改变 0B-8 Contract 语义和源码树发布能力的前提下，为 schema codegen 建立第一个原生、可缓存的 Bazel action。

## 2. 目标

- 把纯生成逻辑与源码树发布逻辑拆成两个明确组件。
- 使用 Bazel 管理 Node.js、TypeScript 和 npm 依赖，不读取宿主 `node_modules`。
- 让 Bazel 精确声明 codegen 的输入和 4 个输出。
- 验证本地 action cache 命中、输入失效和跨平台字节一致性。
- 在 CI 中验证 Bazel 生成结果与仓库提交产物一致。
- 保留现有 `pnpm --filter @colorful-code/schema schema:generate` 更新流程和原子恢复语义。

## 3. 非目标

- 不迁移 Web、Server、CLI、Tauri、Rust、SwiftUI 或整个 pnpm workspace。
- 不替换 Bun test、Turbo、Cargo 或现有根级 Bazel 编排目标。
- 不把源码树发布器搬入 Bazel sandbox。
- 不在本阶段接入 remote cache、remote execution 或共享 disk cache。
- 不修改 OpenAPI、Event Schema、TypeScript 或 Swift Contract 的语义和字节格式。
- 不新增 npm、Yarn 或其他第二份依赖锁文件。
- 不把 code signing、公证、发布或版本 stamping 纳入 codegen action。

## 4. 方案选择

### 4.1 直接用 `genrule` 调用宿主 Bun

该方案改动最少，但 action 会依赖 PATH、宿主 Bun 和宿主 `node_modules`。Bazel 无法完整追踪工具与依赖版本，缓存结果不可靠，也不具备 remote execution 前提，因此不采用。

### 4.2 为 Bazel 单独维护 Bun toolchain

该方案可以保留 Bun 执行语义，但需要维护 Darwin、Linux 和未来 Windows 的 Bun 二进制、平台选择与 npm 依赖图。对第一个 codegen 试点而言，维护成本高于收益，因此不采用。

### 4.3 使用 `rules_js`、`rules_ts` 和固定 Node.js toolchain

该方案把 emitter 编译成 JavaScript，并在 Bazel 管理的 Node.js 运行时中执行。npm 依赖继续以现有 `pnpm-lock.yaml` 为唯一解析来源。纯生成 action 不导入 Bun FFI 或源码树发布层。

本设计采用该方案。

## 5. 组件边界

### 5.1 纯生成内核

从现有 `generate.ts` 提取 `createContractOutputs()`。该函数只组合已有 registry、JSON Schema IR 和 emitter，返回只读的 `relativePath -> UTF-8 text` 映射。

纯生成内核必须满足：

- 不读取或写入文件系统；
- 不读取 cwd、环境变量、时间、PID、hostname 或随机数；
- 不调用 Bun FFI；
- 不根据平台改变输出内容；
- 不执行异步初始化或维护全局可变 registry；
- 保留 0B-8 已有的 JSON parse、generated header 和输出集合完整性校验。

### 5.2 源码树发布器

现有 `generate.ts` 继续作为开发者更新入口。它调用纯生成内核取得内容，再复用已有的互斥锁、staging、事务恢复和原子 promotion 流程写入 `packages/schema`。

该入口仍由以下命令驱动：

```bash
pnpm --filter @colorful-code/schema schema:generate
```

源码树发布器不是 Bazel build action，也不承诺可缓存或可远程执行。

### 5.3 Bazel runner

新增 Node.js runner。它调用同一纯生成内核，并把 4 个输出分别写入 Bazel 传入的声明路径。

Bazel runner 必须满足：

- 每个输出路径由命令行参数显式传入；
- 只创建声明的输出及必要父目录；
- 不写源码树；
- 不创建 lock、staging、journal、quarantine 或 backup；
- 不读取宿主 `node_modules`、Bun 或 pnpm 安装目录；
- 输出失败时以非零状态退出，且不把半成品声明为成功 action。

## 6. Bazel 工具链与依赖

`MODULE.bazel` 增加并固定以下直接依赖：

- [`aspect_rules_js` 3.2.3](https://registry.bazel.build/modules/aspect_rules_js)，提供 `js_binary`、`js_run_binary` 和 pnpm lock 转换能力；
- [`aspect_rules_ts` 3.8.11](https://registry.bazel.build/modules/aspect_rules_ts)，提供 `ts_project`；
- [`rules_nodejs` 6.7.3](https://registry.bazel.build/modules/rules_nodejs)，用于显式引用并注册 Node.js toolchain；该版本与 `aspect_rules_js` 3.2.3 的依赖基线一致。

虽然 `rules_nodejs` 也是 `aspect_rules_js` 的传递依赖，本仓库仍将它声明为直接依赖，因为 `MODULE.bazel` 需要直接引用其 `node` extension。Bzlmod 最终解析出的完整版本图由 `MODULE.bazel.lock` 固定。

实施时固定：

- Bazel：继续使用 `.bazelversion` 中的 `9.1.0`；
- Node.js：`22.22.3`；
- pnpm：继续读取根 `package.json` 中的 `11.0.8`；
- npm graph：通过 `npm_translate_lock` 读取根 `pnpm-lock.yaml`。

Bazel 不生成或维护第二份 lockfile。`MODULE.bazel.lock` 记录 Bazel module 解析结果，并随本次变更一起提交。

codegen target 只链接执行所需的 npm package。第一阶段至少包含 `zod` 和 TypeScript 编译工具，不把整个 workspace 的 npm 依赖无差别加入 runfiles。

## 7. Bazel 目标图

在 `packages/schema/BUILD.bazel` 中建立以下目标：

```text
//packages/schema:codegen_lib
        ↓
//packages/schema:codegen_runner
        ↓
//packages/schema:contract_codegen
        ↓
//packages/schema:contract_codegen_check
```

### 7.1 `codegen_lib`

使用 `ts_project` 编译 Contract authoring source、registry、纯生成内核和 emitter。声明的输入至少覆盖：

- `packages/schema/src/**/*.ts`；
- `packages/schema/scripts/lib/**/*.ts`；
- 纯生成内核与 Bazel runner；
- schema package 的 TypeScript 配置；
- 被链接的 npm 依赖。

源码树发布器中的 Bun FFI、锁和恢复实现不进入 `codegen_lib` 的运行时依赖闭包。

### 7.2 `codegen_runner`

使用 `js_binary` 暴露 Bazel 管理的 Node.js 可执行入口。runner 只依赖 `codegen_lib` 和必要 npm package。

### 7.3 `contract_codegen`

使用 `js_run_binary` 或等价的声明式 action 执行 runner，并逐项声明 4 个输出。输出位于 Bazel output tree，不直接覆盖仓库中的 generated fixture。

输出集合固定为：

```text
openapi.v2.json
events.schema.json
contracts.ts
ColorfulCodeContracts.swift
```

实现可以在 Bazel output tree 中增加稳定目录前缀，但不能把一个不透明 tree artifact 作为唯一输出；4 个公共产物必须可被下游目标分别引用。

### 7.4 `contract_codegen_check`

比较 `contract_codegen` 的 4 个输出与仓库中提交的 4 个 fixture。任何字节差异、缺失文件或额外文件都使测试失败。

该测试只读源码 fixture 和 Bazel 输出，不调用源码树发布器，也不自动修复 drift。

## 8. 数据流与缓存语义

```text
Zod source / registry / emitter / lockfiles / toolchain
                         ↓
                 Bazel action key
                         ↓
                  codegen_runner
                         ↓
          4 个声明输出进入 Bazel output tree
                         ↓
              contract_codegen_check
                         ↓
              与已提交 fixture 逐字节比较
```

只有声明输入、工具链或命令行发生变化时，`contract_codegen` 才应失效。修改无关文档、应用代码或 0B-9 测试不得触发 codegen action。

本阶段只验证 Bazel 默认本地 action cache。remote cache 必须在跨平台输出稳定、action key 完整和 cache hit 可重复后另行设计。

## 9. CI 集成

在现有 quality job 中增加独立步骤：

```yaml
- name: Verify Bazel contract codegen
  run: bazel test //packages/schema:contract_codegen_check
```

该步骤应尽量放在 `pnpm install --frozen-lockfile` 之前。它必须仅依赖 Bazel 管理的 Node.js 和 npm graph；若移除宿主 `node_modules` 或 PATH 中的 Bun 后无法运行，说明目标仍存在未声明依赖，不能通过 hardening Gate。

现有 `Verify Bazel orchestration contract`、lint、typecheck、build 和 test 步骤保持不变。

## 10. 错误处理

- TypeScript 编译失败时，Bazel action 不运行 runner。
- registry 或 emitter 生成失败时，runner 输出明确的 schema 或 emitter 错误并返回非零状态。
- runner 缺少任何输出参数、收到重复输出路径或路径逃逸时立即失败。
- 生成结束后，runner 校验 4 个输出全部存在且互不重复。
- fixture drift 只由 `contract_codegen_check` 报告，不在测试中修改工作区。
- 不支持的 Zod 节点继续按 0B-8 规则失败，不能降级为宽松 `{}`。

## 11. 测试与验收

### 11.1 构建图

```bash
bazel query '//packages/schema:*'
bazel build //packages/schema:contract_codegen
bazel test //packages/schema:contract_codegen_check
```

### 11.2 Hermeticity

- 在不存在宿主 `node_modules` 的隔离 checkout 中构建成功。
- PATH 中没有 Bun 和 pnpm 时构建成功。
- Bazel sandbox 中没有源码树写入。
- action 不读取绝对路径、hostname、PID、时间、随机数或未声明环境变量。

### 11.3 确定性与缓存

- `bazel clean` 后生成的 4 个产物与已提交 fixture byte-for-byte 相同。
- macOS 与 Linux CI 生成相同 SHA-256。
- 连续执行第 2 次命中 Bazel cache，不重新运行生成 action。
- 修改任一 authoring schema、registry 或 emitter 后，action 正确失效。
- 只修改无关文档时，action 保持 cache hit。

### 11.4 兼容性

- 原有 `schema:generate` 命令行为和故障恢复测试保持通过。
- schema package 的 test、lint、typecheck、build 和 format 全部通过。
- 生成的 Swift fixture 继续通过 `swiftc -typecheck`。
- `MODULE.bazel.lock` 与 `pnpm-lock.yaml` 保持一致，无第二份 npm 解析来源。

## 12. Hardening Gate

进入 Phase 0B-9 前必须满足：

- 纯生成内核与源码树发布器职责分离；
- Bazel 使用固定 Node.js toolchain 和 `pnpm-lock.yaml` 管理 codegen 依赖；
- `contract_codegen` 只读取声明输入并写入 4 个声明输出；
- `contract_codegen_check` 能发现任何 generated fixture drift；
- 不依赖宿主 Bun、pnpm 或 `node_modules`；
- macOS 与 Linux 输出哈希一致；
- 本地 action cache 命中和输入失效行为经过验证；
- 原有 0B-8 生成、恢复和 conformance 行为无回归；
- 未引入 remote cache、remote execution 或无关 workspace 迁移；
- 全部验证通过后停止，等待用户验收，再进入 Phase 0B-9。

## 13. 后续演进

该试点稳定后，后续阶段可以按收益逐步扩展：

1. 评估将 Contract conformance test 作为原生 Bazel test；
2. 在 Rust Credential Broker 出现后评估 `rules_rust`；
3. 在 Phase 9 Release Engineering 中让 Bazel 管理可缓存的 unsigned artifact graph；
4. 只有在多个原生 action 已稳定获得 cache hit 后，再单独设计 remote cache。

本设计不承诺全仓 Bazel 化。Bazel 只接管输入输出明确、可复现且能从缓存中获益的构建边界。
