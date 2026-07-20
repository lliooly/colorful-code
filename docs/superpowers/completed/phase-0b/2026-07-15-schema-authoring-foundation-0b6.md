# Schema Authoring Foundation 0B-6 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-5 经用户验收后才能执行；完成后停在 0B-6 Gate。

**目标：** 冻结 durable/transient 双 cursor 事件协议、causal basis、SnapshotReset、UnknownEvent fallback、ThreadStreamFrame 和 Stream state snapshot。

**架构：** payload schema 与 envelope schema 分离；known events 使用 kind discriminated union，envelope 再以 durability 区分。unknown fallback 通过纯解析函数在已知 union 失败后处理，非关键未知 frame 保留原 envelope/cursor，关键未知 frame 返回明确 reset-required 结果。SnapshotReset 是 control frame，不占任何 sequence。

**技术栈：** Zod 4、TypeScript、Bun test

---

### 任务 1：Durable/Transient envelope 与 causal basis

**文件：** `packages/schema/src/events.ts`、`packages/schema/test/event-envelope.test.ts`

- [ ] **步骤 1：写 envelope 红灯测试**

公共 EventBase required `eventId,threadId,kind,critical,occurredAt,payload`，optional `runId,planGeneration`。Durable required `durability:'durable',durableSequence`，optional strict streamBasis `{incarnationId,streamSequence}`。Transient required `durability:'transient',incarnationId,streamSequence,durableBasis`。所有 cursor 是 decimal string。

- [ ] **步骤 2：定义已知 durable payload union**

精确锁定：`thread.updated`、`thread.lifecycleChanged`、`run.statusChanged`、`queue.changed`、`operation.completed`、`operation.failed`、`operation.cancelled`、`approval.requested`、`approval.resolved`、`approval.expired`、`tool.terminal`。每个 payload 引用 0B-3/0B-5 资源或 terminal schema，不复制字段模型；0B-7 只按计划新增 `credential.revoked`。

- [ ] **步骤 3：定义已知 transient payload union**

锁定：`assistant.textDelta`、`assistant.reasoningDelta`、`tool.stdoutDelta`、`tool.stderrDelta`、`operation.progressDelta`。delta 为 bounded string chunk 或 progress；禁止 secret/raw credential 字段。

- [ ] **步骤 4：实现 envelope factory 与测试**

envelope factory 为纯函数，不注册 mutable global。测试 durable 不接受 transient cursor，transient 不接受 durableSequence，streamBasis 两字段不可拆分。

### 任务 2：Snapshot、Stream state 与 SnapshotReset

**文件：** `packages/schema/src/snapshot.ts`、`packages/schema/test/snapshot-reset.test.ts`

- [ ] **步骤 1：完善 StreamStateSnapshot**

定义 bounded `assistantBuffers` 与 `toolBuffers`；每项绑定 runId/incarnationId/lastStreamSequence/status/interruptionReason。禁止 completed buffer 缺少 terminal timestamp，interrupted buffer缺少 interruptionReason。

- [ ] **步骤 2：定义 SnapshotReset**

strict shape：`kind:'stream.snapshotReset',resetId,threadId,reason,snapshot,durableCursor,incarnationId?,streamCursor?`；reason 精确为 `cursorExpired | incarnationChanged | daemonRestarted | streamStateUnavailable | runtimeNotLoaded`。

- [ ] **步骤 3：实现 cursor 一致性 refine**

frame durableCursor 必须等于 snapshot.durableCursor；incarnationId/streamCursor 必须成对出现并与 snapshot 完全相等。无 runtime 时 snapshot 也不得带 streamState。对每种不一致写独立 reject test。

### 任务 3：UnknownEventEnvelope 与兼容性结果

**文件：** `packages/schema/src/events.ts`、`packages/schema/test/unknown-event.test.ts`

- [ ] **步骤 1：写 unknown non-critical fixture**

未知 durable/transient kind 保留 eventId、kind、critical、payload 和对应 cursor/basis；`parseThreadStreamFrame` 返回 `{ outcome:'unknownNonCritical',frame }`，调用方可推进 cursor。原始 JSON payload 只能是 jsonValueSchema。

- [ ] **步骤 2：写 critical unknown fixture**

critical true 的未知 kind 不返回可应用 frame；结果为 `{ outcome:'resetRequired',reason:'criticalUnknownEvent',eventId,kind }`。格式损坏返回 `{ outcome:'protocolError',error:ApiError.error }`，不得伪装成 unknown fallback。

- [ ] **步骤 3：实现已知优先解析**

解析顺序固定：SnapshotReset → known durable/transient → structurally valid unknown → protocol error。known critical event 仍按 known branch 解析；unknown schema 不得吞掉已知 event 的 validation failure。

### 任务 4：ThreadStreamFrame、attach/reset 类型与协议不变量

**文件：** `packages/schema/src/events.ts`、`packages/schema/src/commands.ts`、`packages/schema/test/thread-stream-frame.test.ts`

- [ ] **步骤 1：定义 frame contract**

导出 known `threadStreamFrameSchema` 与兼容 parser result schema。`SnapshotReset` 无 durability/sequence；known frames 必须有且只有各自 cursor 空间。

- [ ] **步骤 2：定义双 cursor attach**

`EventAttachParams` 为 `durableAfter?` 加可选 runtime pair `incarnationId+streamAfter`；定义 attach accepted/reset response discriminated union。禁止单个 `lastEventId` 替代双 cursor。

- [ ] **步骤 3：静态 causal-cycle 检查**

schema 只能表达“basis 指向既有 high-watermark”，不能执行时间比较；契约 description 明确 basis 不可互比、不是第三 cursor。测试 JSON Schema description 包含 durableBasis/streamBasis 语义并且字段类型均为 string。

- [ ] **步骤 4：完整验证与中间提交**

运行 test、lint、typecheck、build、format、diff check。主代理复核 unknown critical、安全降级和 cursor 一致性；最后修正未提交。

## 0B-6 Gate

- durable/transient envelope、basis、SnapshotReset、ThreadStreamFrame、ThreadSnapshot/StreamState 和 attach/reset 类型全部存在；
- unknown non-critical 可保留 cursor，unknown critical 明确 reset-required；
- malformed known critical frame 不会被 unknown fallback 吞掉；
- cursor 全部使用 string，reset 与 snapshot cursor 强一致；
- 没有 EventMux、barrier、ring buffer、SSE handler 或 reducer 运行逻辑；
- 全部验证通过后停止，等待用户验收。
