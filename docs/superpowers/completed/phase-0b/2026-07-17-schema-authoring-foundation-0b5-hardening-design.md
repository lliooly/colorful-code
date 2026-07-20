# Schema Authoring Foundation 0B-5 Hardening Design

## Context

0B-5 已实现 CommandAck、replay、ApiError、ErrorCode HTTP 映射和 Operation terminal payload。0B-6 将直接复用 Ack 的 completion event kind 与 ApiError，0B-8 将从权威 Zod schema 生成多语言契约。因此在 0B-5 验收前收紧这两个边界，避免后续事件协议和生成产物建立在宽松或不可静态表达的节点上。

## Scope

本次只完成三项 hardening：

1. ApiError schema 树中不再包含 transform。
2. 异步 CommandAck 强制同时携带 `operationId` 与非空 `completionEvents`。
3. 冻结 Ack 可引用的 completion event kind。

不实现 0B-6 事件 envelope、SnapshotReset 或 unknown event fallback；不实现 0B-8 generator、Bazel target、生成产物或 action cache。

## ApiError contract

`ApiError.error.details` 使用纯 `z.record(z.string(), z.json())` 表达 JSON object。该 schema 直接位于 errors authoring module，不引用带显式 transform/pipe 的运行时 JSON normalizer。

ApiError 继续保持 strict envelope 和 strict payload，稳定字段、ErrorCode、关联 ID、`retryable` 语义不变。details 仍只接受 JSON object，不接受数组或 JSON 标量。

循环引用、getter、Proxy 等不是 JSON wire value。它们不再由 ApiError authoring schema 承担防御性快照职责；HTTP JSON parser、body-size/resource budget 和应用入口负责把输入限制为已解析 JSON。现有 JSON normalizer 保留给仍需要运行时快照隔离的其他 schema，本次不做全局重构。

## CommandAck contract

`commandAckSchema(resultSchema?)` 返回两个 strict object branch 的纯 union：

- 同步 Ack：不得出现 `operationId` 或 `completionEvents`。
- 异步 Ack：`operationId` 和 `completionEvents` 都是 required；`completionEvents` 至少包含一项。

两个 branch 共享 `commandId`、`status:'accepted'`、`replayed`、`threadId`、可选 `runId`、`currentDurableCursor` 和 `acceptedAt`。有 result schema 时两个 branch 都允许可选 `result`；无 result schema 时两个 branch 都拒绝 `result`。replay 仍由同一个 schema 表达，只允许切换 `replayed`。

使用结构化 union 而不是 `superRefine`，让约束可以由 JSON Schema/OpenAPI 原生表示，并避免为 0B-8 引入 custom refine 节点。

## Completion event kinds

新增可复用的公共 enum schema，精确冻结：

- `operation.completed`
- `operation.failed`
- `operation.cancelled`

该 enum 位于公共 enums authoring module，Ack 引用它；0B-6 后续复用同一权威定义。Ack 拒绝未知 kind，`completionEvents` 使用非空数组。当前不额外要求数组必须包含全部三项，也不引入去重 refine，以免把未被协议要求的集合策略写入 wire contract。

## Testing

按 TDD 增加以下门禁：

- ApiError details 的可达 schema AST 不含显式 transform/pipe/custom refine，并可原生导出 JSON Schema。现有权威 ID 和 message schema 的 Zod 原生 string normalization check 保持不变，本次不复制 ID schema 或改变全局 ID 语义。
- ApiError details 接受递归 JSON object，拒绝数组、标量和非 JSON 值。
- 同步 Ack 接受两字段均缺失，拒绝任一字段单独出现。
- 异步 Ack 仅在 `operationId` 与非空 `completionEvents` 同时存在时接受。
- completion event enum 只接受三个冻结值，生成 JSON Schema 保留 enum。
- original/replayed Ack、result/no-result factory 和所有 mutation registry fixture 继续通过。

完成后重新执行 schema tests、workspace tests、lint、typecheck、build、schema-scoped format 和 diff check，并由主代理复核共享可变状态、Schema factory 重入、registry 冻结及范围边界。
