# Schema Authoring Foundation 0B-3 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-2 经用户验收后才能执行；完成后停在 0B-3 Gate。

**目标：** 用 Zod 定义规范中全部客户端可见资源，并用负向测试证明内部 runtime、lease、worker routing、attempt、inbox 和数据库字段不会泄漏。

**架构：** 资源按 thread/run/queue/operations/snapshot 领域组合；所有 object 使用 `.strict()`，可缺失字段使用 optional，已知为空使用 nullable。公共 View 只表达查询投影，不复刻数据库 row。

**技术栈：** Zod 4、TypeScript、Bun test

---

## 最终资源形状

- `ThreadView`: thread/lineage/parent IDs、lifecycle/runtimeStatus、title/goal、workspaceBinding、activeRunId、thread/queue/config/policy revisions、timestamps。
- `RunView`: IDs、kind/status、source Input/Queue、plan/config/policy revisions、terminalReason、timestamps、revision。
- `InputItemView`: immutable ID、threadId、role/source、discriminated content、supersedesInputItemId、createdAt。
- `QueueItemView`: ID、InputItemView、status、source/resulting Run IDs、revision、timestamps；不暴露 position key。
- `QueueView`: threadId、items、controlState、blockedByIndeterminate、effectiveState、revision。
- `TranscriptItemView`: IDs、kind/status、content、finishReason、run/tool/operation references、timestamps。
- `OperationView`: IDs、kind/status/phase、parent/run references、expected/applied generation、target/applied config/policy revisions、progress/result/error、revision、timestamps。
- `ApprovalView`: IDs、kind/status、run/generation/policy/revision、request summary、decision、timestamps；不暴露 lease epoch。
- `ToolExecutionSummary`: IDs、tool name、state、generation/policy revision、redacted summary、artifact references、timestamps；不暴露 arguments、attempt、permit 或 routing。
- `ThreadSnapshot`: bounded resources、optional active Run、pages、pending operations/approvals、tool summaries、cursor 与 stream state。

### 任务 1：Thread、Run 和不可变 Input 资源

**文件：** `packages/schema/src/thread.ts`、`packages/schema/src/run.ts`、`packages/schema/test/thread-run-resources.test.ts`

- [ ] **步骤 1：写 strict resource 红灯测试**

为 ThreadView、RunView、InputItemView 建立最小有效 fixture；逐字段验证 optional/nullable：`parentThreadId`、`activeRunId`、`title`、`goal`、`terminalReason` 是存在且 nullable，`deletedAt` 仅 deleted lifecycle 可出现但 schema 层保持 optional nullable。任意 `leaseEpoch`、`workerId`、`runtimeSessionId`、`projectionRevision`、`clientIdentity` 必须因 strict object 被拒绝。

- [ ] **步骤 2：实现 discriminated InputContent**

定义 `text`、`structured`、`artifactReferences` 三个 branch：text 需要非空 `text`；structured 使用 `jsonValueSchema`；artifactReferences 使用非空 artifactId array。`InputItemView` 的 `content` 只能来自该 union，不能用无界 `unknown`。

- [ ] **步骤 3：实现 ThreadView 与 RunView**

`workspaceBinding` 仅包含公共 `workspaceId`、`displayPath`、`trust`，不得包含本地 routing/lock。Run terminalReason 使用 strict `{ code, message?, details? }`，details 为 JSON value。

- [ ] **步骤 4：运行测试与 typecheck**

预期所有正例 parse、内部字段反例 reject。

### 任务 2：Queue 与 Transcript 资源

**文件：** `packages/schema/src/queue.ts`、`packages/schema/test/queue-transcript-resources.test.ts`

- [ ] **步骤 1：写 Queue 红灯测试**

验证 QueueView 同时保留 `controlState`、boolean `blockedByIndeterminate`、派生 `effectiveState`；测试 `pausedByStop + blocker` 可同时表达。QueueItemView 必须嵌入或引用 immutable InputItemView，不暴露 server position。

- [ ] **步骤 2：写 Transcript 红灯测试**

用 `kind` 区分 input、assistant、tool、system、operation payload；assistant streaming/interrupted/completed 的 content 与 finishReason optional/nullable 区别固定。拒绝 tool raw stdout、secret、attemptId 和未声明字段。

- [ ] **步骤 3：实现 strict schemas 并验证**

所有 branch 都使用 discriminated union；运行 targeted tests、typecheck、build。

### 任务 3：Operation、Approval 与 Tool summary

**文件：** `packages/schema/src/operations.ts`、`packages/schema/test/operation-resources.test.ts`

- [ ] **步骤 1：写 OperationView 红灯测试**

覆盖每种 Operation status/kind；nullable references 明确为字段存在但值可空。progress 使用 bounded strict `{ phase, completedUnits?, totalUnits?, message? }`。result/error 使用 JSON-safe、redacted summary，不接受 payloadHash、acceptedLedgerSequence、coordinationCycleId 或内部 snapshot JSON。

- [ ] **步骤 2：写 ApprovalView 与 ToolExecutionSummary 红灯测试**

Approval 不接受 lease epoch、owner incarnation；Tool summary 不接受 arguments、idempotencyKey、permitId、attemptId、workerId、raw stdout/stderr。artifact references 只含 artifactId、mediaType、byteLength、label。

- [ ] **步骤 3：实现并运行全量资源测试**

预期 strict reject 与 enum coverage 全部通过。

### 任务 4：ThreadSnapshot 与内部边界 Gate

**文件：** `packages/schema/src/snapshot.ts`、`packages/schema/test/snapshot-resource.test.ts`、`packages/schema/test/public-resource-boundary.test.ts`

- [ ] **步骤 1：写 ThreadSnapshot 红灯测试**

形状固定为 thread、optional activeRun、recentRuns page、queue、pendingOperations、pendingApprovals、transcript page、toolExecutions、optional streamState、durableCursor、optional incarnationId/streamCursor、snapshotVersion。`streamState` 使用 bounded partial message/tool buffers，状态为 0B-2 enum。

- [ ] **步骤 2：实现跨字段 refine**

incarnationId 与 streamCursor 必须同时存在或同时缺失；stream state 存在时必须有 runtime cursor。activeRun 按 normative `activeRun?: RunView` 表达：存在 active Run 时提供，缺失时省略，禁止显式 null。

- [ ] **步骤 3：建立内部名称与字段 denylist**

扫描所有 exported schema 的 JSON Schema 结果和 source，拒绝 `RuntimeSession`、`Lease`、`workerRouting`、`ToolExecutionAttempt`、`LateObservationInbox`、`projectionRevision`、`permitId`、`leaseEpoch`。denylist 只存在测试文件中。

- [ ] **步骤 4：完整验证与中间提交**

运行 schema test、lint、typecheck、build、format、diff check。只提交 0B-3 范围，主代理最终修正保持未提交。

## 0B-3 Gate

- 十个客户端可见资源全部由 Zod authoring 并由 `z.infer` 导出；
- strict object、optional/nullable、discriminated content 全部有正反 fixture；
- 内部 Runtime、Lease、worker、attempt、inbox、数据库/projection 字段全部无法 parse；
- 没有 Command/Query、Ack 或事件 envelope，未进入 0B-4；
- 全部验证通过后停止，等待用户验收。
