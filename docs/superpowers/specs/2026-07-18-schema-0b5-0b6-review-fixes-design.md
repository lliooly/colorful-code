# Schema 0B-5 / 0B-6 Review 修复设计

## 背景

0B-5 与 0B-6 的运行时 Schema 已具备基础安全边界，但 Review 发现 6 处契约问题：`ApiError.details` 的递归解析可能栈溢出；`SnapshotReset` 与 frame 预算不一致；envelope 工厂丢失类型信息；JSON 对象使用 null prototype；assistant delta 缺少关联键；operation completion kind 存在多份手写真相源。

本次只修复上述 6 项，不顺带处理 Review 中其余性能或代码生成问题。

## 目标

- 所有不可信 JSON 输入都通过迭代式、有长度与 token 上限的解析路径。
- `SnapshotReset` 的运行时合法范围不超过 `parseThreadStreamFrame` 的输入预算。
- envelope 工厂保留 kind literal 与具体 payload 类型，支持 discriminated union 收窄。
- JSON 对象输出遵循普通 JavaScript 对象语义，同时继续安全保留 `__proto__` 数据键。
- assistant delta 明确关联到 `transcriptItemId`。
- operation completion kind 只由 `operationCompletionEventKindSchema` 定义；reserved kind 集合从已知 Schema 派生。

## 方案

### Bounded JSON object

在 `common.ts` 提供 bounded JSON object 工厂。它复用现有迭代式 JSON encoder、长度预算、token 预算与 decoder，并在类型和 JSON Schema 中保持「JSON-valued object」语义。`ApiError.details` 使用该工厂，不再直接递归调用 `z.json()` 解析任意深度的原始对象。

`details` 采用独立、保守的错误元数据预算。超过预算或包含非 JSON 值时，`safeParse()` 返回失败，不向调用方抛出 `RangeError`。

### Frame 与 SnapshotReset 预算

16 MiB / 250,000 token 的 frame 入口预算保持不变。预算常量移到事件与 snapshot 均可复用的模块，避免重复定义。

`SnapshotReset` 在结构校验前应用同一总预算，因此任何由导出 `snapshotResetSchema` 接受的值，也能通过 `parseThreadStreamFrame` 的预算门禁。stream state 另设更小的聚合子预算，为 snapshot 的 thread、queue、transcript 和 operation 等基础字段保留空间。该约束是运行时防护；现有 Zod refine 无法完整表达为 JSON Schema 的限制不在本次范围内。

### Envelope 工厂类型

为 durable 与 transient envelope 工厂声明与输入 payload shape 关联的精确返回类型。返回类型必须保留：

- `kind` 的单一 string literal；
- payload Schema 的具体输出类型；
- durable/transient 各自的 cursor 与 basis 字段。

新增独立 `.typecheck.ts` 断言，验证工厂结果不会退化成 `string` 或 `JsonValue`。

### 普通对象 prototype

`decodeJsonValue` 使用普通对象 `{}` 创建 JSON object。属性仍统一通过 `Object.defineProperty` 写入，因此 `__proto__`、`constructor` 和 `prototype` 只作为 own data property，不触发 setter，也不会污染 `Object.prototype`。

回归测试覆盖 `hasOwnProperty()`、`toString()`、模板字符串，以及嵌套 `__proto__` 数据键。

### Assistant delta 关联键

`assistant.textDelta` 与 `assistant.reasoningDelta` 的 payload 都要求 `transcriptItemId` 和 `chunk`。消费者按 `transcriptItemId` 选择目标 buffer，不依赖「同时只有一个活跃 assistant 消息」的隐式约定。

本次不新增 reasoning buffer 字段；reasoning 内容如何进入 snapshot 属于后续协议设计。

### Event kind 单一真相源

三个 operation completion payload kind 从 `operationCompletionEventKindSchema` 取值，不在 `events.ts` 重复写字符串。`reservedEventKinds` 由 known durable envelope、known transient envelope 与 snapshot reset kind 自动派生，新增 known event 时无需同步第三份列表。

## 错误处理

- 超长、超复杂、循环、带访问器或非 JSON 的 details/reset 输入都返回 Zod validation failure 或 `protocolError`，不得泄漏内部异常。
- 已知 kind 的 malformed frame 仍不得落入 unknown fallback。
- 普通 prototype 不改变 pollution 防护；危险键必须保留为数据，不得影响原型链。

## 测试策略

每项修复遵循红—绿—重构：

1. 深层 `ApiError.details`：先复现 `safeParse()` 抛错，再验证其稳定返回失败。
2. 构造接近合法上界的 `SnapshotReset`，验证导出 Schema 与 frame parser 对预算的判定一致。
3. 用编译期精确类型断言锁定 kind 与 payload。
4. 验证普通 prototype API 与 `__proto__` pollution 防护同时成立。
5. 验证两个 assistant delta 都缺键失败、带键成功。
6. 验证 enum 中每个 completion kind 都存在于 durable union，known union 的所有 kind 都被 unknown 分支排除。

最后执行仓库定义的 test、typecheck、lint、build 与 format/diff 检查。

## 非目标

- 不重构 event payload 的重复 JSON 编解码路径。
- 不改变 unknown event fallback 与 cursor 语义。
- 不处理 `threadStreamFrameSchema` 手写分支漂移或所有导出 Schema 的默认预算问题。
- 不解决 Zod `superRefine` 转换为 JSON Schema 时丢失约束的问题。
