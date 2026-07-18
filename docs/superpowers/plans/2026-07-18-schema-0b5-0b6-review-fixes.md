# Schema 0B-5 / 0B-6 Review 修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 0B-5 / 0B-6 Review 指出的 6 处 JSON 安全、预算一致性、类型推断与事件契约问题。

**架构：** 先在 `common.ts` 建立 bounded JSON object 与普通 prototype 的安全基础，再用共享 limits 对齐 frame 与 reset。事件层保留具体 Zod 类型，assistant delta 显式绑定 transcript item，known/reserved kinds 从权威 Schema 派生。

**技术栈：** TypeScript 5.9、Zod 4.4、Bun test、pnpm、ESLint、Prettier

---

## 文件结构

- 创建 `packages/schema/src/stream-limits.ts`：frame、snapshot reset 与 stream state 的共享预算常量。
- 创建 `packages/schema/test/event-envelope.typecheck.ts`：envelope 工厂 literal kind 与 payload 类型的编译期断言。
- 修改 `packages/schema/src/common.ts`：bounded JSON object 工厂与普通 prototype decoder。
- 修改 `packages/schema/src/errors.ts`：为 `ApiError.details` 应用 bounded JSON object。
- 修改 `packages/schema/src/snapshot.ts`：为 stream state 与 `SnapshotReset` 应用共享聚合预算。
- 修改 `packages/schema/src/events.ts`：精确 envelope 返回类型、assistant delta 关联键、enum/union 派生 kind、共享 frame 预算。
- 修改 `packages/schema/test/common-types.test.ts`：普通 prototype 与 pollution 回归测试。
- 修改 `packages/schema/test/api-error.test.ts`：深层和超预算 details 回归测试。
- 修改 `packages/schema/test/snapshot-reset.test.ts`：reset 与 parser 预算一致性测试。
- 修改 `packages/schema/test/event-envelope.test.ts`：assistant delta 关联键测试。
- 修改 `packages/schema/test/unknown-event.test.ts`：completion enum 与 reserved kinds 派生测试。

### 任务 1：普通 prototype 与 bounded JSON object

**文件：**
- 修改：`packages/schema/test/common-types.test.ts`
- 修改：`packages/schema/src/common.ts`

- [ ] **步骤 1：编写普通 prototype 与 bounded object 红灯测试**

在 `common-types.test.ts` 导入 `createBoundedJsonObjectSchema`，增加：

```ts
test('returns ordinary objects without weakening prototype pollution defenses', () => {
  const input = JSON.parse('{"value":1,"__proto__":{"polluted":true}}');
  const parsed = jsonValueSchema.parse(input) as Record<string, unknown>;

  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(parsed.hasOwnProperty('value')).toBe(true);
  expect(parsed.toString()).toBe('[object Object]');
  expect(`${parsed}`).toBe('[object Object]');
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
  expect(Object.prototype).not.toHaveProperty('polluted');
});

test('bounds JSON objects iteratively while preserving object JSON Schema', () => {
  const schema = createBoundedJsonObjectSchema(100, 20);
  expect(schema.safeParse({ nested: { value: 1 } }).success).toBe(true);
  expect(schema.safeParse([]).success).toBe(false);
  expect(z.toJSONSchema(schema).type).toBe('object');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/schema exec bun test test/common-types.test.ts`

预期：FAIL；`createBoundedJsonObjectSchema` 未导出，且现有 parsed object 的 prototype 为 `null`。

- [ ] **步骤 3：实现最少基础设施**

在 `decodeJsonValue` 中把 object 容器改为普通对象，但继续使用现有 `Object.defineProperty` attach 逻辑：

```ts
const value: JsonValue = kind === 'array' ? [] : ({} as JsonObject);
```

抽取预算参数验证与 object token wrapper，新增：

```ts
export const createBoundedJsonObjectSchema = (
  maxSerializedLength: number,
  maxTokenCount?: number,
) => boundedJsonObjectNormalizer(maxSerializedLength, maxTokenCount)
  .pipe(jsonObjectOutputSchema)
  .overwrite((value) => decodeJsonValue(value['\u0000']) as JsonObject);
```

bounded normalizer 必须调用 `encodeJsonValue(value, maxSerializedLength, maxTokenCount)`，确认根 token 为 object，并沿用 value schema 的三类错误消息。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @colorful-code/schema exec bun test test/common-types.test.ts`

预期：PASS，且现有深层 JSON 与 `__proto__` 测试不回归。

### 任务 2：限制 ApiError.details

**文件：**
- 修改：`packages/schema/test/api-error.test.ts`
- 修改：`packages/schema/src/errors.ts`

- [ ] **步骤 1：编写深层 details 红灯测试**

```ts
test('rejects over-complex details without throwing', () => {
  const details: Record<string, unknown> = {};
  let tail = details;
  for (let index = 0; index < 2_500; index += 1) {
    tail.next = {};
    tail = tail.next as Record<string, unknown>;
  }
  const input = {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      retryable: false,
      details,
    },
  };

  expect(() => apiErrorSchema.safeParse(input)).not.toThrow();
  expect(apiErrorSchema.safeParse(input).success).toBe(false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/schema exec bun test test/api-error.test.ts`

预期：FAIL；现有递归 `z.json()` 抛出 `RangeError`。

- [ ] **步骤 3：应用 bounded object**

在 `errors.ts` 定义 64 KiB / 10,000 token 的 details 预算，并替换原 Schema：

```ts
const apiErrorDetailsSchema = createBoundedJsonObjectSchema(65_536, 10_000);
```

更新现有 `__proto__` 测试预期：危险键作为 own data property 保留，prototype 为 `Object.prototype`，全局 prototype 未污染。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @colorful-code/schema exec bun test test/api-error.test.ts test/ack-error-invariants.test.ts`

预期：PASS。

### 任务 3：对齐 frame、stream state 与 SnapshotReset 预算

**文件：**
- 创建：`packages/schema/src/stream-limits.ts`
- 修改：`packages/schema/src/events.ts`
- 修改：`packages/schema/src/snapshot.ts`
- 修改：`packages/schema/test/snapshot-reset.test.ts`

- [ ] **步骤 1：编写预算一致性红灯测试**

在 `snapshot-reset.test.ts` 导入 `parseThreadStreamFrame`，构造超过 16 MiB 的 assistant buffers，并断言 Schema 与 parser 结果一致：

```ts
const oversizedReset = {
  ...runtimeReset,
  snapshot: {
    ...runtimeSnapshot,
    streamState: {
      assistantBuffers: Array.from({ length: 17 }, (_, index) => ({
        ...assistantStreaming,
        transcriptItemId: `transcript-${index}`,
        text: 'x'.repeat(1_048_576),
      })),
      toolBuffers: [],
    },
  },
};

expect(snapshotResetSchema.safeParse(oversizedReset).success).toBe(false);
expect(parseThreadStreamFrame(oversizedReset).outcome).toBe('protocolError');
```

再保留一个小型 reset，断言两者均接受。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/schema exec bun test test/snapshot-reset.test.ts`

预期：FAIL；`snapshotResetSchema` 接受 oversized reset，而 parser 返回 `protocolError`。

- [ ] **步骤 3：建立共享预算并约束 Schema**

在 `stream-limits.ts` 导出：

```ts
export const MAX_THREAD_STREAM_FRAME_SERIALIZED_LENGTH = 16 * 1024 * 1024;
export const MAX_THREAD_STREAM_FRAME_TOKEN_COUNT = 250_000;
export const MAX_STREAM_STATE_SERIALIZED_LENGTH = 8 * 1024 * 1024;
export const MAX_STREAM_STATE_TOKEN_COUNT = 100_000;
```

`events.ts` 从该模块读取 frame 限制。`snapshot.ts` 用 `createBoundedJsonValueSchema` 先限制 stream state，再 pipe 到 raw stream state shape；`snapshotResetSchema` 同样先应用 frame 总预算，再 pipe 到带现有 causal refine 的结构 Schema。保持对外输出类型不变。

- [ ] **步骤 4：运行预算相关测试验证通过**

运行：`pnpm --filter @colorful-code/schema exec bun test test/snapshot-reset.test.ts test/thread-stream-frame.test.ts test/unknown-event.test.ts`

预期：PASS；合法小 frame 仍为 `known`，超预算 reset 在两条入口均被拒绝。

### 任务 4：修复 envelope 工厂泛型推断

**文件：**
- 创建：`packages/schema/test/event-envelope.typecheck.ts`
- 修改：`packages/schema/src/events.ts`

- [ ] **步骤 1：编写编译期红灯断言**

```ts
import { z } from 'zod';
import {
  createDurableEventEnvelopeSchema,
  createEventPayloadSchema,
  createTransientEventEnvelopeSchema,
} from '@colorful-code/schema/events';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

const payload = createEventPayloadSchema(
  'example.created',
  z.strictObject({ value: z.string() }),
);
const durable = createDurableEventEnvelopeSchema(payload);
const transient = createTransientEventEnvelopeSchema(payload);

export type DurableKindIsLiteral = Expect<
  Equal<z.output<typeof durable>['kind'], 'example.created'>
>;
export type DurablePayloadIsConcrete = Expect<
  Equal<z.output<typeof durable>['payload'], { value: string }>
>;
export type TransientKindIsLiteral = Expect<
  Equal<z.output<typeof transient>['kind'], 'example.created'>
>;
```

- [ ] **步骤 2：运行 typecheck 验证失败**

运行：`pnpm --filter @colorful-code/schema typecheck`

预期：FAIL；kind/payload 的 Equal 断言不满足 `true`。

- [ ] **步骤 3：实现精确返回类型**

为 factory 输入使用 `const Shape` 泛型，建立 durable/transient raw shape 类型，并显式返回 `z.ZodObject<...>`。payload 字段必须使用输入 `eventPayloadSchema.shape.payload` 对应的 wire output，kind 字段必须保留输入 literal Schema，而不是退回 `eventBaseShape` 的 `z.string()`。

- [ ] **步骤 4：运行 typecheck 与 envelope 测试**

运行：`pnpm --filter @colorful-code/schema typecheck && pnpm --filter @colorful-code/schema exec bun test test/event-envelope.test.ts`

预期：PASS。

### 任务 5：添加 assistant delta 关联键

**文件：**
- 修改：`packages/schema/test/event-envelope.test.ts`
- 修改：`packages/schema/test/thread-stream-frame.test.ts`
- 修改：`packages/schema/test/unknown-event.test.ts`
- 修改：`packages/schema/src/events.ts`

- [ ] **步骤 1：更新 fixture 并编写缺键红灯测试**

所有合法 assistant delta fixture 增加 `transcriptItemId: 'transcript-1'`，并新增：

```ts
for (const kind of ['assistant.textDelta', 'assistant.reasoningDelta'] as const) {
  const schema = knownTransientEventPayloadSchema.options.find(
    (option) => option.shape.kind.value === kind,
  );
  expect(schema?.safeParse({ kind, payload: { chunk: 'delta' } }).success)
    .toBe(false);
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/schema exec bun test test/event-envelope.test.ts`

预期：FAIL；当前 assistant payload 不要求 `transcriptItemId`。

- [ ] **步骤 3：实现关联键**

在 `events.ts` 导入 `transcriptItemIdSchema`：

```ts
const assistantDeltaPayloadSchema = strictObjectSchema({
  transcriptItemId: transcriptItemIdSchema,
  chunk: deltaChunkSchema,
});
```

- [ ] **步骤 4：运行事件测试验证通过**

运行：`pnpm --filter @colorful-code/schema exec bun test test/event-envelope.test.ts test/thread-stream-frame.test.ts test/unknown-event.test.ts`

预期：PASS。

### 任务 6：从权威 Schema 派生 operation 与 reserved kinds

**文件：**
- 修改：`packages/schema/test/unknown-event.test.ts`
- 修改：`packages/schema/src/events.ts`

- [ ] **步骤 1：补充 enum/union 一致性特征测试**

```ts
const durableKinds = new Set(
  knownDurableEventEnvelopeSchema.options.map((option) => option.shape.kind.value),
);
expect(operationCompletionEventKindSchema.options.every((kind) =>
  durableKinds.has(kind),
)).toBe(true);
```

保留现有 unknown exclusion 测试作为 reserved kind 行为特征测试；它枚举 known union，而不是在测试中复制 kind 字符串。

- [ ] **步骤 2：运行测试并确认重构基线**

运行：`pnpm --filter @colorful-code/schema exec bun test test/unknown-event.test.ts`

预期：PASS。此项是由特征测试保护的结构重构；运行时值当前一致，缺陷是未来修改时存在多份真相源，因此不伪造行为红灯。

- [ ] **步骤 3：派生 kind**

在 `events.ts`：

```ts
const [operationCompletedKind, operationFailedKind, operationCancelledKind] =
  operationCompletionEventKindSchema.options;

const reservedEventKinds = Object.freeze([
  snapshotResetKindSchema.value,
  ...knownDurableEventEnvelopeSchema.options.map((option) => option.shape.kind.value),
  ...knownTransientEventEnvelopeSchema.options.map((option) => option.shape.kind.value),
]);
```

三个 operation payload factory 使用上述 enum-derived literal。删除手写 reserved known kind 列表。

- [ ] **步骤 4：运行 unknown/operation 测试验证通过**

运行：`pnpm --filter @colorful-code/schema exec bun test test/unknown-event.test.ts test/operation-completion.test.ts test/event-envelope.test.ts`

预期：PASS。

### 任务 7：完整验证与提交

**文件：**
- 检查：本计划列出的全部源文件、测试与文档

- [ ] **步骤 1：运行 Schema 包完整验证**

运行：

```bash
pnpm --filter @colorful-code/schema test
pnpm --filter @colorful-code/schema typecheck
pnpm --filter @colorful-code/schema lint
pnpm --filter @colorful-code/schema build
```

预期：全部 exit 0，测试 0 failures，TypeScript 与 ESLint 无错误。

- [ ] **步骤 2：运行仓库级格式与受影响构建检查**

运行：

```bash
pnpm exec prettier --check packages/schema/src packages/schema/test docs/superpowers/specs/2026-07-18-schema-0b5-0b6-review-fixes-design.md docs/superpowers/plans/2026-07-18-schema-0b5-0b6-review-fixes.md
git diff --check
```

预期：Prettier 报告所有文件符合格式，`git diff --check` 无输出。

- [ ] **步骤 3：逐项审查需求与 diff**

运行：`git diff --stat && git diff -- packages/schema/src packages/schema/test`

确认 6 项需求均有生产变更和回归测试，且没有实现非目标重构。

- [ ] **步骤 4：提交实现**

```bash
git add packages/schema/src packages/schema/test docs/superpowers/plans/2026-07-18-schema-0b5-0b6-review-fixes.md
git commit -m "fix(schema): address 0B-5 0B-6 review findings"
```
