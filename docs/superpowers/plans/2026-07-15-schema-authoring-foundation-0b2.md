# Schema Authoring Foundation 0B-2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。只有 0B-1 已由用户验收后才能执行；完成后停在 0B-2 Gate，等待用户验收。

**目标：** 用 Zod 定义所有公共标量、资源 ID、revision/cursor 与正式状态枚举，并建立禁止 1.x Session/Chat 术语污染 v2 契约的自动检查。

**架构：** `ids.ts` 只定义 branded string ID；`common.ts` 定义 JSON 安全标量、分页和 revision；`enums.ts` 定义稳定 enum schema；`errors.ts` 先定义完整 ErrorCode enum，ApiError 留给 0B-5。所有 TypeScript 类型只能由 `z.infer` 得到，不手写镜像 interface/type union。

**技术栈：** Zod 4、TypeScript、Bun test、ES modules

---

## 文件与契约清单

- 修改 `packages/schema/src/ids.ts`：`threadId`、`lineageId`、`runId`、`queueItemId`、`inputItemId`、`transcriptItemId`、`operationId`、`approvalId`、`toolExecutionId`、`checkpointId`、`contextBoundaryId`、`eventId`、`resetId`、`incarnationId`、`commandId`、`credentialRefId`、`daemonInstanceId`、`artifactId`、`workspaceId`、`principalId`、`pluginId`。
- 修改 `packages/schema/src/common.ts`：ISO timestamp、canonical unsigned decimal cursor、revision/generation、JSON value、page cursor、`PageInfo` 和 `pageSchema(item)`。
- 修改 `packages/schema/src/enums.ts`：Thread、Run、Queue、Operation、Approval、Tool、Input、Transcript、Submission、Steer、stream 状态枚举。
- 修改 `packages/schema/src/errors.ts`：规范第 6 节 25 个稳定 `ErrorCode`。
- 创建 `packages/schema/test/common-types.test.ts`。
- 创建 `packages/schema/test/enums.test.ts`。
- 创建 `packages/schema/test/public-vocabulary.test.ts`。

### 任务 1：公共标量与资源 ID

**文件：** `packages/schema/src/common.ts`、`packages/schema/src/ids.ts`、`packages/schema/test/common-types.test.ts`

- [ ] **步骤 1：写红灯测试**

测试每个 ID 接受非空、无首尾空白的 opaque string，拒绝空串和空白；不同 ID 的 `z.infer` 在 TypeScript 中不可互换。测试 timestamp 接受带时区 ISO-8601，拒绝无时区字符串。测试 durable/stream cursor 接受 `"9007199254740993"` 并拒绝 number、负数、前导零和小数。测试 revision/configRevision/policyRevision/planGeneration 仅接受 `Number.isSafeInteger` 范围内非负整数。

运行：`pnpm --filter @colorful-code/schema test -- common-types`

预期：FAIL，缺少上述 schema export。

- [ ] **步骤 2：实现最小 Zod 标量**

使用 `z.string().trim().min(1).brand<'ThreadId'>()` 形式建立 ID；cursor 使用 `/^(0|[1-9]\d*)$/`；时间使用 `z.iso.datetime({ offset: true })`；revision 使用 `z.number().int().nonnegative().safe()`。定义递归 `jsonValueSchema`，禁止 `undefined`、BigInt、函数和非 JSON 对象。`PageInfo` 固定为 strict object：`nextCursor: pageCursor.nullable()`、`hasMore: z.boolean()`；`pageSchema(item)` 返回 strict `{ items, pageInfo }`。

- [ ] **步骤 3：验证绿灯**

运行 common-types test、typecheck、build，预期全部 exit 0。

### 任务 2：正式状态和类型枚举

**文件：** `packages/schema/src/enums.ts`、`packages/schema/test/enums.test.ts`

- [ ] **步骤 1：写完整 enum 红灯测试**

以表驱动测试锁定以下精确集合：

- `ThreadLifecycle`: `available | archived | deleted`
- `ThreadRuntimeStatus`: `notLoaded | loading | idle | running | recovering | blocked`
- `RunStatus`: `starting | running | steering | stopping | recovering | blocked | completed | failed | stopped`
- `RunKind`: `interactive | checkpointApply`
- `QueueControlState`: `active | pausedByUser | pausedByStop | pausedByFailure`
- `EffectiveQueueDispatchState`: QueueControlState 加 `blockedByIndeterminate`
- `QueueItemStatus`: `queued | consumed | removed`
- `OperationStatus`: `accepted | executing | waiting | blocked | completed | failed | cancelled`
- `OperationKind`: `steer | stop | checkpointApply | compaction | policyReconcile | threadResume | threadUndelete | threadArchive | threadDelete | lateObservationReconcile | modelInvocation | toolInvocation`
- `ApprovalStatus`: `pending | approved | denied | expired | cancelled`
- `ApprovalKind`: `toolExecution | workspaceMutation | networkAccess | credentialUse`
- `ApprovalDecision`: `approve | deny`
- `ToolExecutionState`: `scheduled | running | cancelRequested | completed | failed | cancelled | indeterminate`
- `InputRole`: `user | system`
- `InputSource`: `submission | steer | automation | recovery | checkpointApply`
- `TranscriptItemKind`: `input | assistant | tool | system | operation`
- `TranscriptStatus`: `streaming | interrupted | completed`
- `SubmissionDisposition`: `auto | enqueue | requireImmediate`
- `SteerStalePolicy`: `reject | enqueue`
- `StreamStateStatus`: `streaming | interrupted | completed`
- `StreamInterruptionReason`: `steered | stopped | daemonLost | streamStateUnavailable`

每个 enum 必须接受全部声明值，拒绝大小写变体、旧值和未知值。

- [ ] **步骤 2：用 `z.enum` 实现并由 `z.infer` 导出类型**

不另写 TypeScript union；集合常量如果需要测试复用，直接从 `schema.options` 读取，避免第二份值列表成为契约来源。规范中重复出现的 `waiting` 只保留一次。

- [ ] **步骤 3：运行 enum test、typecheck、build**

预期 enum 表完整通过且 declaration 中所有类型来自 `z.infer`。

### 任务 3：完整 ErrorCode 与旧术语 Gate

**文件：** `packages/schema/src/errors.ts`、`packages/schema/test/enums.test.ts`、`packages/schema/test/public-vocabulary.test.ts`

- [ ] **步骤 1：为 ErrorCode 写红灯测试**

锁定规范中的 25 个 code：`VALIDATION_ERROR`、`THREAD_NOT_FOUND`、`THREAD_ARCHIVED`、`THREAD_DELETED`、`THREAD_PURGE_STARTED`、`THREAD_NOT_IMMEDIATELY_RUNNABLE`、`RUN_NOT_FOUND`、`RUN_NOT_ACTIVE`、`RUN_ALREADY_TERMINAL`、`STALE_PLAN_GENERATION`、`STALE_INCARNATION`、`QUEUE_ITEM_NOT_FOUND`、`QUEUE_ITEM_ALREADY_CONSUMED`、`QUEUE_REVISION_CONFLICT`、`COMMAND_ID_CONFLICT`、`APPROVAL_EXPIRED`、`OPERATION_CONFLICT`、`CONFIG_REVISION_CONFLICT`、`POLICY_REVISION_CONFLICT`、`RUNTIME_DRAINING`、`RECOVERY_BLOCKED`、`INDETERMINATE_SIDE_EFFECT`、`AUTHENTICATION_REQUIRED`、`CREDENTIAL_UNAVAILABLE`、`INTERNAL_ERROR`。

- [ ] **步骤 2：实现 vocabulary 静态检查**

测试扫描 `packages/schema/src` 的 exported identifier、schema description 和 string literal；禁止 `Session`、`Chat` 用作 v2 领域名，禁止 `sessionId`、`chatId`、`chatMessage`。允许 `public-vocabulary.test.ts` 自身的 denylist 字面量，但不允许正式 source 出现。错误信息必须列出文件、行号和命中的旧术语。

- [ ] **步骤 3：验证并提交中间检查点**

运行 schema test、lint、typecheck、build、Prettier check 和 `git diff --check`。只提交 0B-2 文件；主代理复核后保留最后修正未提交供用户验收。

## 0B-2 Gate

- 所有 ID、时间、分页、revision、generation、durable/stream cursor 与 incarnation schema 存在；
- 64-bit cursor 不经过 JavaScript number；
- 所有正式状态/类型 enum 与 25 个 ErrorCode 精确匹配；
- 正式 schema source 不含 1.x Session/Chat 替代 Thread/Run；
- 没有资源 View、Command、Ack 或 Event envelope，未进入 0B-3；
- test、lint、typecheck、build、format 和 diff check 全部通过；
- 停止并等待用户验收，不启动 0B-3。
