# Schema Codegen Bazel Hardening 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。步骤使用复选框（`- [ ]`）语法跟踪进度；每个任务遵循 superpowers:test-driven-development。

**目标：** 在不改变 0B-8 产物和源码树原子发布语义的前提下，建立使用固定 Node.js toolchain、`pnpm-lock.yaml` 与四个显式输出的原生 Bazel schema codegen action，并在 CI 检查 fixture drift。

**架构：** 将纯 `createContractOutputs()` 从 Bun FFI 发布器中提取，源码树入口继续调用现有锁/恢复发布流程；Bazel runner 只接受四个命名输出参数，在 Bazel output tree 写文件。`ts_project` 编译纯生成闭包，`js_binary` 提供 Node 入口，`js_run_binary` 产生四个文件，`sh_test` 逐字节比较提交 fixture。

**技术栈：** Bazel 9.1.0、Bzlmod、aspect_rules_js 3.2.3、aspect_rules_ts 3.8.11、rules_nodejs 6.7.3、Node.js 22.22.3、TypeScript 5.9、Zod 4、Bun test

---

## 文件结构

- 创建 `packages/schema/scripts/create-contract-outputs.ts`：无 I/O、无环境读取的纯生成内核与固定输出类型。
- 修改 `packages/schema/scripts/generate.ts`：只保留源码树发布职责并调用纯内核。
- 创建 `packages/schema/scripts/bazel-runner.ts`：验证四个显式输出参数并写 Bazel 声明输出。
- 创建 `packages/schema/scripts/check-bazel-outputs.ts`：逐字节比较 Bazel 输出与提交 fixture。
- 创建 `packages/schema/test/create-contract-outputs.test.ts`：纯内核边界、确定性和无发布层依赖测试。
- 创建 `packages/schema/test/bazel-runner.test.ts`：参数、重复路径、路径安全和失败清理测试。
- 修改 `MODULE.bazel`、`MODULE.bazel.lock`：固定 Node/JS/TS rules 与 pnpm npm graph。
- 创建 `packages/schema/BUILD.bazel`：`codegen_lib`、`codegen_runner`、`contract_codegen` 与 `contract_codegen_check`。
- 修改 `.github/workflows/ci.yml`：在宿主依赖安装前运行 Bazel drift 检查。

### 任务 1：提取纯生成内核

**文件：**
- 创建：`packages/schema/scripts/create-contract-outputs.ts`
- 修改：`packages/schema/scripts/generate.ts`
- 创建：`packages/schema/test/create-contract-outputs.test.ts`

- [ ] **步骤 1：编写纯内核红灯测试**

测试导入 `createContractOutputs`，断言 key 与 `GENERATED_PATHS` 精确一致、JSON 可解析、generated header 保留、连续调用逐 byte 相等；同时读取模块 import graph，断言纯内核不导入 `bun:ffi`、`node:fs`、`node:os`、`node:perf_hooks`、`generate.ts`。

```ts
expect(Object.keys(createContractOutputs()).sort()).toEqual(
  [...GENERATED_PATHS].sort(),
);
expect(createContractOutputs()).toEqual(createContractOutputs());
expect(source).not.toMatch(/bun:ffi|node:fs|node:os|node:perf_hooks/u);
```

- [ ] **步骤 2：运行测试确认因模块缺失而失败**

运行：`pnpm --filter @colorful-code/schema exec bun test test/create-contract-outputs.test.ts`

预期：FAIL，错误包含 `Cannot find module '../scripts/create-contract-outputs.js'`。

- [ ] **步骤 3：实现最小纯内核并让发布器复用**

```ts
export const GENERATED_PATHS = [
  'generated/openapi.v2.json',
  'generated/events.schema.json',
  'generated/typescript/contracts.ts',
  'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
] as const;

export type ContractOutputs = Readonly<
  Record<(typeof GENERATED_PATHS)[number], string>
>;

export const createContractOutputs = (): ContractOutputs => {
  const ir = createJsonSchemaIr(contractRegistry.schemas);
  return Object.freeze({
    'generated/openapi.v2.json': stableJson(createOpenApiDocument(ir)),
    'generated/events.schema.json': stableJson(createEventsSchema(ir)),
    'generated/typescript/contracts.ts': createTypeScriptContracts(
      contractRegistry.schemas,
    ),
    'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift':
      createSwiftContracts(ir),
  });
};
```

`generate.ts` 从该模块导入 `GENERATED_PATHS`/`createContractOutputs`，不得复制输出组合逻辑；现有 `publishGeneratedOutputs`、锁、journal、恢复与 CLI 行为保持不变。

- [ ] **步骤 4：运行新增测试和原有生成测试**

运行：`pnpm --filter @colorful-code/schema exec bun test test/create-contract-outputs.test.ts test/generation.test.ts`

预期：PASS，且原有锁/恢复测试无回归。

### 任务 2：实现严格 Bazel runner

**文件：**
- 创建：`packages/schema/scripts/bazel-runner.ts`
- 创建：`packages/schema/test/bazel-runner.test.ts`

- [ ] **步骤 1：编写 runner 红灯测试**

用临时目录覆盖：缺参数、未知参数、重复逻辑名称、两个参数解析为同一路径、输出不是绝对路径、父目录逃逸/符号链接、成功写四个文件、任一写入失败时返回非零且不留下 runner 创建的半成品。

```ts
expect(() => parseOutputArguments([])).toThrow(/missing output/u);
expect(() => parseOutputArguments([
  '--openapi=/tmp/shared',
  '--events=/tmp/shared',
  '--typescript=/tmp/contracts.ts',
  '--swift=/tmp/contracts.swift',
])).toThrow(/unique/u);
```

- [ ] **步骤 2：运行测试确认因 API 缺失而失败**

运行：`pnpm --filter @colorful-code/schema exec bun test test/bazel-runner.test.ts`

预期：FAIL，错误包含 `Cannot find module '../scripts/bazel-runner.js'`。

- [ ] **步骤 3：实现最小参数解析与写入**

runner 固定接受 `--openapi=...`、`--events=...`、`--typescript=...`、`--swift=...`。解析后对规范化绝对路径做唯一性检查；先验证所有父目录均为真实目录或由 runner 创建，再以 `wx` 创建临时 sibling、写入并关闭，最后逐个 rename 到声明路径。失败时只清理本进程 nonce 命名的临时文件，不删除既有目标；Bazel action 失败后不把部分结果视为成功。

```ts
const OUTPUT_KEYS = ['openapi', 'events', 'typescript', 'swift'] as const;
const OUTPUT_TO_CONTRACT = {
  openapi: 'generated/openapi.v2.json',
  events: 'generated/events.schema.json',
  typescript: 'generated/typescript/contracts.ts',
  swift: 'swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift',
} as const;
```

不得导入 `generate.ts`、Bun FFI、锁、journal、hostname、PID、时间或随机 API；临时名使用固定逻辑输出旁由 action 独占的 `.tmp` 后缀，并在开始前要求不存在。

- [ ] **步骤 4：运行 runner 测试和源码树生成回归**

运行：`pnpm --filter @colorful-code/schema exec bun test test/bazel-runner.test.ts test/create-contract-outputs.test.ts test/generation.test.ts`

预期：PASS；随后运行两次 `pnpm --filter @colorful-code/schema schema:generate`，第二次受管路径零 diff。

### 任务 3：固定 Bzlmod 工具链与 npm graph

**文件：**
- 修改：`MODULE.bazel`
- 修改：`MODULE.bazel.lock`

- [ ] **步骤 1：写 Bazel query 红灯验证**

运行：`bazel query //packages/schema:contract_codegen`

预期：FAIL，错误为 package/target 不存在。

- [ ] **步骤 2：声明固定模块、Node toolchain 与 pnpm lock extension**

```starlark
bazel_dep(name = "aspect_rules_js", version = "3.2.3")
bazel_dep(name = "aspect_rules_ts", version = "3.8.11")
bazel_dep(name = "rules_nodejs", version = "6.7.3")

node = use_extension("@rules_nodejs//nodejs:extensions.bzl", "node")
node.toolchain(node_version = "22.22.3")
use_repo(node, "nodejs_toolchains")

npm = use_extension("@aspect_rules_js//npm:extensions.bzl", "npm")
npm.npm_translate_lock(
    name = "npm",
    pnpm_lock = "//:pnpm-lock.yaml",
)
use_repo(npm, "npm")
```

若实际固定版本导出的 repository 名称不同，以该版本官方 extension 输出为准，不使用宿主 PATH fallback。Bazel 9 使用根 `REPO.bazel` 的 `ignore_directories(["**/node_modules"])` 时，新增该文件并纳入本任务。

- [ ] **步骤 3：刷新并审查 lock**

运行：`bazel mod graph`。

预期：exit 0；`MODULE.bazel.lock` 只出现固定 module/toolchain/npm extension 解析变化，没有第二份 npm lockfile。

### 任务 4：建立四输出 Bazel target 与 drift test

**文件：**
- 创建：`packages/schema/BUILD.bazel`
- 创建：`packages/schema/scripts/check-bazel-outputs.ts`

- [ ] **步骤 1：让 query 先失败并确认红灯来自目标缺失**

运行：`bazel query '//packages/schema:*'`。

预期：FAIL，错误包含 `BUILD file not found`。

- [ ] **步骤 2：定义编译、runner 与四输出 action**

`ts_project(name = "codegen_lib")` 的 `srcs` 精确列举 `src/**/*.ts`、纯内核、runner 和 emitter，不包含 `generate.ts`；`deps` 仅链接 `//:node_modules/zod` 与 Node 类型/TypeScript 编译所需目标。`js_binary(name = "codegen_runner")` 的入口来自编译输出。`js_run_binary(name = "contract_codegen")` 显式声明四个 `outs` 并通过 `$(execpath ...)` 参数传给 runner。

```starlark
js_run_binary(
    name = "contract_codegen",
    srcs = [":codegen_lib"],
    tool = ":codegen_runner",
    args = [
        "--openapi=$(execpath :openapi.v2.json)",
        "--events=$(execpath :events.schema.json)",
        "--typescript=$(execpath :contracts.ts)",
        "--swift=$(execpath :ColorfulCodeContracts.swift)",
    ],
    outs = [
        "openapi.v2.json",
        "events.schema.json",
        "contracts.ts",
        "ColorfulCodeContracts.swift",
    ],
)
```

按该固定版本 API 调整 label 展开语法，但保持四个普通 file artifacts，不退化为 tree artifact/genrule/宿主 Bun。

- [ ] **步骤 3：编写 drift checker 并验证失败路径**

checker 只读四个 runner 输出和四个源码 fixture，逐 byte 比较；缺失、内容不同、输出数量不等于四均返回非零。诊断只打印逻辑名称和相对路径，不打印 payload。

- [ ] **步骤 4：定义并运行 `contract_codegen_check`**

运行：

```bash
bazel query '//packages/schema:*'
bazel build //packages/schema:contract_codegen
bazel test //packages/schema:contract_codegen_check
```

预期：四个命令 exit 0；`bazel-bin/packages/schema/` 中四个产物与提交 fixture SHA-256 一致。

### 任务 5：缓存、hermeticity 与 CI Gate

**文件：**
- 修改：`.github/workflows/ci.yml`
- 测试：`packages/schema/BUILD.bazel`

- [ ] **步骤 1：加入 CI Bazel codegen 检查**

在 quality job 的 Bazel setup 后、`pnpm install --frozen-lockfile` 前执行：

```yaml
- name: Verify Bazel contract codegen
  run: bazel test //packages/schema:contract_codegen_check
```

把宿主依赖安装步骤下移，但不改变现有 Bazel orchestration、lint、typecheck、build、test 的顺序语义。

- [ ] **步骤 2：验证无宿主 Bun/pnpm/node_modules 依赖**

使用最小 PATH（仅 Bazel 所需系统命令）和临时 `--output_user_root` 运行 `bazel test //packages/schema:contract_codegen_check`；通过 `bazel aquery` 审查 action inputs，不得包含工作区 `node_modules`、Bun、源码树锁/transaction/staging 路径或未声明环境。

- [ ] **步骤 3：验证缓存命中与失效边界**

连续两次以 `--execution_log_json_file` 构建，第二次 `contract_codegen` 不重新执行；在临时 git 副本分别改 authoring schema 与无关文档，前者必须执行 codegen，后者必须命中缓存。所有临时修改仅发生在独立临时副本，不触碰用户工作区。

- [ ] **步骤 4：完整回归和锁/竞态专项审查**

运行：

```bash
bazel test //packages/schema:contract_codegen_check
pnpm --filter @colorful-code/schema schema:generate
pnpm --filter @colorful-code/schema test
pnpm --filter @colorful-code/schema lint
pnpm --filter @colorful-code/schema typecheck
pnpm --filter @colorful-code/schema build
swiftc -typecheck packages/schema/swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift
pnpm format
git diff --check
```

主代理逐项检查：纯内核无共享可变状态；Bazel runner 无锁且 action 输出独占；源码树发布器锁顺序和 ownership 未改变；失败清理不删除其他进程文件；不存在检查后使用前的 symlink 替换窗口；CI 不依赖宿主安装顺序；测试无 secret/payload 回显。

## Hardening Gate

- 纯生成与源码树发布边界明确，既有锁/恢复行为无回归；
- Bazel 固定 Node.js 与 npm graph，只使用 `pnpm-lock.yaml`；
- 四个产物是独立声明输出并与提交 fixture byte-for-byte 一致；
- runner 对参数冲突、路径不安全和部分写入安全失败；
- 第二次构建命中缓存，schema/emitter 变更失效，无关文档不失效；
- CI 在安装宿主 pnpm/Bun dependencies 前完成 Bazel codegen check；
- 全部验证通过后停止，等待用户验收，再进入 0B-9。
