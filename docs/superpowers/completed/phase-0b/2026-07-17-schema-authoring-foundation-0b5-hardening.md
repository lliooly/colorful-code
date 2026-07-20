# Schema Authoring Foundation 0B-5 Hardening 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 0B-5 验收前移除 ApiError authoring tree 的 transform，收紧异步 Ack 成对字段，并冻结 completion event kind。

**架构：** ApiError details 改用 errors 模块内的纯递归 JSON object schema；CommandAck 由同步/异步两个 strict object branch 构成纯 union；completion event kind 在 enums 模块定义并供 Ack 引用。所有约束使用 Zod 原生节点表达，不新增 refine、transform 或运行时注册逻辑。

**技术栈：** TypeScript、Zod 4、Bun test、pnpm/Turborepo

---

## 文件结构

- 修改 `packages/schema/src/errors.ts`：定义无 transform 的 ApiError details contract。
- 修改 `packages/schema/src/enums.ts`：冻结三种 operation completion event kind。
- 修改 `packages/schema/src/ack.ts`：构造同步/异步 Ack union。
- 修改 `packages/schema/test/api-error.test.ts`：验证 ApiError AST 与 wire JSON 边界。
- 修改 `packages/schema/test/enums.test.ts`：验证 completion event enum 精确集合。
- 修改 `packages/schema/test/command-ack.test.ts`：验证 Ack 成对约束、非空事件和 replay。
- 修改 `packages/schema/test/ack-error-invariants.test.ts`：适配 union factory 隔离测试并移除非 wire object 假设。
- 修改必要的 command registry 测试 fixture：只把旧的自由字符串 completion event 改为冻结值，不改变 endpoint 范围。

### 任务 1：移除 ApiError authoring tree 中的 transform

**文件：**

- 修改：`packages/schema/src/errors.ts`
- 测试：`packages/schema/test/api-error.test.ts`
- 测试：`packages/schema/test/ack-error-invariants.test.ts`

- [ ] **步骤 1：编写失败的纯 Schema 测试**

在 `api-error.test.ts` 导入 `z`，递归遍历 ApiError details 的可达 schema 节点，断言 schema def 不包含显式 `transform`/`pipe`/custom refine，并运行 `z.toJSONSchema(apiErrorSchema)` 验证 details 为 object 且 `additionalProperties` 指向 JSON value schema。不要把权威 ID 和 message schema 的 Zod 原生 string normalization overwrite check 视为本任务禁止节点。

同时保留 wire fixture：递归 JSON object 成功；`null`、数组、标量、`undefined`、BigInt 和 Date 失败。删除 getter/proxy/alias snapshot 等依赖 transform 的非 wire-object 断言。

- [ ] **步骤 2：运行测试并确认红灯**

运行：`pnpm --filter @colorful-code/schema test`

预期：新增 AST 测试因 ApiError details 仍引用 `jsonObjectSchema` 的 transform/pipe 而 FAIL。

- [ ] **步骤 3：实现最小纯 details schema**

在 `errors.ts` 使用：

```ts
const apiErrorDetailsSchema = z.record(z.string(), z.json());

export const apiErrorPayloadSchema = z.strictObject({
  // existing stable fields unchanged
  details: apiErrorDetailsSchema.optional(),
});
```

不导出新的公共 helper，不删除 `common.ts` 的运行时 JSON normalizer，不增加 preprocess/refine/transform/pipe。保留现有 ID/message schema 引用和语义，不在 errors 模块复制 ID schema。

- [ ] **步骤 4：运行测试并确认绿灯**

运行：`pnpm --filter @colorful-code/schema test`

预期：ApiError 测试通过；如纯 `z.json()` 对循环 JS object 不保证 safeParse，则删除 `ack-error-invariants.test.ts` 中循环/proxy 测试，仅保留真实 JSON wire value 与 authoring AST 门禁。

- [ ] **步骤 5：提交任务**

```bash
git add packages/schema/src/errors.ts packages/schema/test/api-error.test.ts packages/schema/test/ack-error-invariants.test.ts
git commit -m "refactor(schema): make ApiError codegen-safe"
```

### 任务 2：冻结 completion event kind 并收紧异步 Ack

**文件：**

- 修改：`packages/schema/src/enums.ts`
- 修改：`packages/schema/src/ack.ts`
- 测试：`packages/schema/test/enums.test.ts`
- 测试：`packages/schema/test/command-ack.test.ts`

- [ ] **步骤 1：编写失败的 event enum 测试**

在 `enums.test.ts` 将 `operationCompletionEventKindSchema` 加入 enum table，期望精确值：

```ts
['operation.completed', 'operation.failed', 'operation.cancelled'];
```

运行 schema tests，预期因 export 不存在而编译 FAIL；这是正确红灯。

- [ ] **步骤 2：实现 event enum 并验证绿灯**

在 `enums.ts` 增加：

```ts
export const operationCompletionEventKindSchema = z.enum([
  'operation.completed',
  'operation.failed',
  'operation.cancelled',
]);
export type OperationCompletionEventKind = z.infer<
  typeof operationCompletionEventKindSchema
>;
```

运行：`pnpm --filter @colorful-code/schema test`

预期：enum tests PASS。

- [ ] **步骤 3：编写失败的 Ack 成对约束测试**

在 `command-ack.test.ts` 使用冻结 event fixture，新增断言：

```ts
expect(schema.safeParse(syncAck).success).toBe(true);
expect(
  schema.safeParse({ ...syncAck, operationId: 'operation-1' }).success,
).toBe(false);
expect(
  schema.safeParse({ ...syncAck, completionEvents: ['operation.completed'] })
    .success,
).toBe(false);
expect(schema.safeParse({ ...asyncAck, completionEvents: [] }).success).toBe(
  false,
);
expect(
  schema.safeParse({ ...asyncAck, completionEvents: ['queue.failed'] }).success,
).toBe(false);
```

另断言 `z.toJSONSchema(schema)` 使用 `anyOf` 表达同步/异步 branch，不含 custom refine。

运行 schema tests，预期单字段和空数组仍被接受或未知 kind 仍被接受，因此 FAIL。

- [ ] **步骤 4：用纯 union 实现最小 Ack**

在 `ack.ts` 抽取共享 shape 和可选 result shape，构造：

```ts
const synchronousAck = strictObjectSchema({ ...commonShape, ...resultShape });
const asynchronousAck = strictObjectSchema({
  ...commonShape,
  operationId: operationIdSchema,
  completionEvents: z.array(operationCompletionEventKindSchema).min(1),
  ...resultShape,
});
return z.union([synchronousAck, asynchronousAck]);
```

同步 branch 不声明 `operationId`/`completionEvents`，借助 strict object 拒绝单独字段。factory 每次创建新 branch 和 union，不缓存 schema。

- [ ] **步骤 5：运行测试并提交任务**

运行：`pnpm --filter @colorful-code/schema test`

预期：Ack、enum 和完整 schema suite 全部 PASS。

```bash
git add packages/schema/src/enums.ts packages/schema/src/ack.ts packages/schema/test/enums.test.ts packages/schema/test/command-ack.test.ts
git commit -m "feat(schema): harden asynchronous command Ack"
```

### 任务 3：适配 registry fixture 与安全不变量

**文件：**

- 修改：`packages/schema/test/ack-error-invariants.test.ts`
- 修改：`packages/schema/test/command-invariants.test.ts`
- 修改：`packages/schema/test/thread-command-contracts.test.ts`
- 修改：`packages/schema/test/run-queue-command-contracts.test.ts`
- 修改：`packages/schema/test/remaining-api-contracts.test.ts`

- [ ] **步骤 1：运行完整 schema suite 收集真实回归**

运行：`pnpm --filter @colorful-code/schema test`

预期：旧 fixture 中 `queue.applied`/`queue.failed` 或只携带一个异步字段的 Ack 失败；旧 `schema.shape` 断言因 factory 现在返回 union 而失败。

- [ ] **步骤 2：只调整与新契约冲突的 fixture**

异步 fixture 统一使用：

```ts
operationId: 'operation-1',
completionEvents: ['operation.completed'],
```

同步 fixture 同时删除两字段。factory 隔离测试改为比较 union 和两个 branch identity：

```ts
expect(first).not.toBe(second);
expect(first.options[0]).not.toBe(second.options[0]);
expect(first.options[1]).not.toBe(second.options[1]);
```

不改变 endpoint 数量、method/path/body/result contract，也不添加 0B-6 event schema。

- [ ] **步骤 3：补充生成与并发安全不变量**

断言 Ack JSON Schema 是两个 strict branch；interleaved factory construction/parse 仍互不污染；HTTP registry 仍同步冻结且无函数、Promise 或 mutable registration。

- [ ] **步骤 4：运行 schema 验证并提交任务**

运行：`pnpm --filter @colorful-code/schema test`

预期：全部 schema tests PASS。

```bash
git add packages/schema/test
git commit -m "test(schema): enforce 0B-5 hardening invariants"
```

### 任务 4：重新执行 0B-5 Gate

**文件：**

- 检查：`packages/schema/src/ack.ts`
- 检查：`packages/schema/src/errors.ts`
- 检查：`packages/schema/src/enums.ts`
- 检查：`packages/schema/src/operations.ts`
- 检查：`packages/schema/src/commands.ts`

- [ ] **步骤 1：执行 change-scoped 验证**

依次运行：

```bash
pnpm --filter @colorful-code/schema test
pnpm exec prettier --check packages/schema
git diff --check
```

预期：全部 exit 0。

- [ ] **步骤 2：执行 workspace Gate**

依次运行：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

预期：全部 exit 0。若根目录 `pnpm format` 仍仅报告既有非 schema 文件，则记录基线，且 `packages/schema` scoped format 必须通过。

- [ ] **步骤 3：主代理安全审查**

逐项确认：

- ApiError details 可达 schema tree 无显式 transform/pipe/custom refine；权威 ID/message 的原生 string normalization check 未被复制或改写。
- Ack 只有同步和异步两个 branch；异步 pair required，事件数组非空且只含冻结 kind。
- factory 无缓存、无共享 mutable state、无 async/lazy initialization。
- registry 与 Error HTTP mapping 仍冻结。
- 未实现 0B-6/0B-8、Bazel、generator、Controller、dedup transaction 或 executor。

- [ ] **步骤 4：停在 0B-5 Gate**

保留功能分支和 worktree，报告提交、未提交最终审查修正、完整验证证据与任何仓库基线问题，等待用户验收后才进入 0B-6。
