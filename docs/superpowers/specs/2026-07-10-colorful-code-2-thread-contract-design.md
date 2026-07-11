# Colorful Code 2.0 Thread Contract

> **Status: Normative**
>
> 本文档定义 Colorful Code 2.0 的公共资源、REST Command/Query、SSE 事件、Snapshot Reset、本地鉴权、错误模型和跨语言 Schema。公共客户端只依赖本文，不依赖 RuntimeSession、Lease 或数据库表。

## 1. 依赖与范围

- [Core Architecture](./2026-07-10-colorful-code-2-core-architecture-design.md) 定义实体和系统不变量。
- [Persistence Foundation](./2026-07-10-colorful-code-2-persistence-foundation-design.md) 定义 Projection、Ledger、Operation 和 Outbox。
- [Runtime Ownership and Recovery](./2026-07-10-colorful-code-2-runtime-ownership-recovery-design.md) 定义 Actor、Snapshot barrier 和 Lease。

2.0 第一版采用 REST Command/Query + SSE server event stream。WebSocket 可以作为后续 transport adapter，但不得改变本文语义。

## 2. 公共资源

客户端可见：

- `ThreadView`
- `RunView`
- `QueueItemView`
- `InputItemView`
- `TranscriptItemView`
- `OperationView`
- `ApprovalView`
- `ToolExecutionSummary`
- `ThreadSnapshot`

`CredentialRefView` 只作为 Thread config/policy 中的嵌入值，不是可读取 secret 的 REST resource。

客户端不可见：

- RuntimeSession 和 Runtime Lease。
- ToolExecutionAttempt。
- Late Observation Inbox。
- 数据库锁、内部 Projection revision 和 worker routing。

## 3. Schema 单一来源

Zod 是唯一 authoring source，按领域拆分：

```text
packages/schema/src/common.ts
packages/schema/src/thread.ts
packages/schema/src/run.ts
packages/schema/src/queue.ts
packages/schema/src/operations.ts
packages/schema/src/commands.ts
packages/schema/src/events.ts
packages/schema/src/snapshot.ts
packages/schema/src/errors.ts
packages/schema/src/auth.ts
packages/schema/src/index.ts
```

生成产物：

- `openapi.v2.json`：HTTP request/response。
- `events.schema.json`：Stream frame discriminated union。
- TypeScript validators 和 client types。
- Swift Codable models fixture。

禁止手写第二份 OpenAPI 或 Swift domain model。CI 必须验证生成产物无漂移，并覆盖 enum、optional、nullable、discriminated union、unknown event fallback 和 64-bit cursor。

所有 mutating request 都必须携带 `commandId`。Server 使用认证得到的 `clientIdentity`，客户端不能在 body 中伪造该字段。需要 revision/generation fencing 的命令还必须携带对应 expected value。

## 4. 公共 API

### 4.1 Thread Lifecycle

```text
POST   /v2/threads
GET    /v2/threads
GET    /v2/threads/{threadId}
PATCH  /v2/threads/{threadId}
DELETE /v2/threads/{threadId}

POST   /v2/threads/{threadId}/resume
POST   /v2/threads/{threadId}/archive
POST   /v2/threads/{threadId}/unarchive
POST   /v2/threads/{threadId}/undelete
POST   /v2/threads/{threadId}/fork
```

- `resume`：创建或复用运行时 owner，绑定当前 Workspace，执行 drift detection 和 reconciliation。
- `archive`：`available -> archived`，不删除历史。
- `unarchive`：`archived -> available`。
- `undelete`：在尚未 purge 时将 tombstone 恢复为 `available`。
- `DELETE`：创建 tombstone；物理 purge 由 retention/GC 完成。
- `fork`：从显式 committed boundary 创建新 Thread；新 Queue 为空且 active，不复制源 Queue、运行时资源、active Run、Operation、Approval 或未终态工具。
- `PATCH` 只修改 title、goal 等非执行 metadata；模型/provider 默认值走 Execution Config Change，插件权限、sandbox、workspace trust、network ceiling 和 credential revocation 走 Policy Change。
- Archive/Delete 在存在 active Run 或冲突性 workspace Operation 时返回 `OPERATION_CONFLICT`，不得隐式 Stop。无 Lease 时可在请求事务内完成；仍有 idle RuntimeSession/Lease 时返回 `threadArchive | threadDelete` Operation，先 drain/release 后提交 lifecycle。成功后 Queue 保留并变为 `pausedByUser`；Unarchive/Undelete 不自动恢复消费。
- Resume 和 Undelete 始终返回 `operationId`；若无需外部协调，Operation 可以在接受事务内直接进入 completed。
- `purge_started_at` 一旦存在，Undelete 返回 `THREAD_PURGE_STARTED`；客户端不能取消或回滚已经开始的 RetentionJob。

Fork request 使用强类型 boundary，不接受未定义的任意字符串：

```ts
type ForkBoundary =
  | { kind: 'latestCommitted' }
  | { kind: 'contextBoundary'; contextBoundaryId: string }
  | { kind: 'checkpoint'; checkpointId: string };
```

Server 在同一 read/write transaction 验证 boundary 已 committed 且属于源 Thread，再创建新 Thread 和 Artifact references。

### 4.2 Submission

所有普通用户输入统一走：

```text
POST /v2/threads/{threadId}/submissions
```

```ts
type SubmitInputCommand = {
  commandId: string;
  input: NewInputItem;
  disposition: 'auto' | 'enqueue' | 'requireImmediate';
};

type SubmitResult =
  | { kind: 'runCreated'; inputItemId: string; runId: string }
  | { kind: 'queueItemCreated'; inputItemId: string; queueItemId: string };
```

Server 必须先验证 Thread lifecycle。`archived` 返回 `THREAD_ARCHIVED`，`deleted` 返回 `THREAD_DELETED`；任一 disposition 都不得向非 available Thread 新建 InputItem 或 QueueItem。

非终态 `threadArchive | threadDelete` Operation 视为 closing gate：所有 Submission 和 Queue mutation 返回 `OPERATION_CONFLICT`，不能因为 lifecycle 暂时仍为 available 而入队。

`auto` 仅在以下条件同时满足时创建 `starting` Run：

- Thread lifecycle 为 `available`。
- 无 active Run。
- Queue 为空、control state 为 `active`，且不存在 indeterminate blocker。
- 无 blocking Operation。
- 无关键 indeterminate fact。
- Runtime owner 可用，或不存在 Lease row 且不存在任何 recovery-required state，可以在创建 Run 的同一事务内安全 acquire。

通过 lifecycle 验证后，不满足立即执行条件的 `auto` 创建 QueueItem，`enqueue` 无条件入队。过期 Lease、未终态 Operation、未协调 ToolExecution 或 Late Observation 都不满足安全 acquire。`requireImmediate` 不能立即执行时返回 `THREAD_NOT_IMMEDIATELY_RUNNABLE`，不创建 QueueItem。普通客户端没有绕过已有 Queue 的优先入口。

### 4.3 Run Query 和 Control

```text
GET  /v2/threads/{threadId}/runs
GET  /v2/threads/{threadId}/runs/{runId}
POST /v2/threads/{threadId}/runs/{runId}/steer
POST /v2/threads/{threadId}/runs/{runId}/stop
```

```ts
type SteerStalePolicy = 'reject' | 'enqueue';
```

Steer request 必须包含目标 `runId`、expected `planGeneration`、`targetConfigRevision`、`expectedPolicyRevision`、输入和 `stalePolicy`（默认 `enqueue`）。Server 在 accepted transaction 捕获对应 config/policy snapshot；之后到达的普通 Config Change 或 policy relax 不改变该 Steer 将创建的 generation，安全 policy tighten 仍可按更高优先级覆盖。

请求接受前目标 Run 已非 active 时返回 `RUN_NOT_ACTIVE`，不创建 Operation。接受后、applied 前目标 Run 终止时，`reject` 使 Operation `cancelled`；`enqueue` 复用尚未进入 Context 的 Steer InputItem 创建 QueueItem，使 Operation `completed` 并返回 queueItemId。该 fallback 排到现有 Queue 尾部并遵循 Queue pause/blocker，不得立即抢跑。Stop request 必须包含目标 `runId`，默认原子暂停 Queue。Stop 优先于尚未 applied 的 Steer。

已有 Steer 正在进行时，target config/policy snapshot 完全相同的新 Steer 加入同一个 coordination cycle；InputItem 按 accepted 顺序进入同一新 generation，所有相关 Operation 返回相同 appliedPlanGeneration。Snapshot 不同或已有 Stop intent 时返回 `OPERATION_CONFLICT`，不创建新的 Steer Operation。

### 4.4 Queue

```text
GET    /v2/threads/{threadId}/queue
PATCH  /v2/threads/{threadId}/queue/items/{queueItemId}
DELETE /v2/threads/{threadId}/queue/items/{queueItemId}
POST   /v2/threads/{threadId}/queue/reorder
POST   /v2/threads/{threadId}/queue/pause
POST   /v2/threads/{threadId}/queue/resume
```

- QueueItem 只能通过 Submission 的 `enqueue/auto` 结果创建，不提供第二个创建语义。
- 所有 Queue mutation 都携带 `expectedQueueRevision` 并执行 CAS。
- 修改 QueueItem 实际创建新 InputItem，并额外使用 `expectedItemRevision` CAS 替换引用。
- Reorder 使用 `beforeItemId` / `afterItemId`，不使用数组下标。
- Queue 暂停时新增项目不会隐式恢复调度。
- QueueView 同时暴露 `controlState`、`blockedByIndeterminate` 和派生 `effectiveState`；blocker 不得覆盖或丢失用户暂停意图。
- Queue resume 只修改 control state；存在 blocking Operation 或关键 indeterminate 时返回冲突且不修改状态。
- Thread closing gate 存在时，Queue patch/delete/reorder/pause/resume 全部拒绝。

### 4.5 Approval

```text
POST /v2/threads/{threadId}/runs/{runId}/approvals/{approvalId}/decision
```

Decision 必须携带 `commandId`、expected Plan Generation 和 Approval revision。Lease takeover、Plan Generation 或安全收紧 Policy Revision 改变后，旧 Approval 为 expired；纯放宽不自动批准旧 Approval，其决定仍按原 generation 的 policy snapshot 校验。迟到决定不得作用于新计划。

### 4.6 Execution Config 和 Policy Change

```text
POST /v2/threads/{threadId}/config/changes
```

Config request 必须携带 `commandId`、`expectedConfigRevision` 和 schema 化 config patch，只允许 model/provider 默认值、非安全生成参数和下一 generation 的普通配置：

- 成功后创建新 config revision，当前 Plan Generation 继续使用旧 immutable model config snapshot。
- 新配置默认从下一 Run 生效；要让当前 Run 切换，客户端随后用该 revision 作为 `targetConfigRevision` 显式 Steer。Recovery 或安全 Policy Reconcile 不得顺带切换模型配置。
- Config patch 不能修改权限 ceiling、trust、sandbox、network policy 或撤销 credential。
- Revision CAS 失败返回 `CONFIG_REVISION_CONFLICT`。

```text
POST /v2/threads/{threadId}/policy/changes
```

Request 必须携带 `commandId`、`expectedPolicyRevision` 和 schema 化 policy patch。Server 对 canonical old/new policy diff 分类，客户端不能提交或覆盖分类结果：

- 纯放宽：创建新 revision，当前 Plan Generation 继续使用旧 immutable policy snapshot；新增能力只在下一 generation 可用。
- 安全收紧或 mixed change：返回 `policyReconcile` Operation，立即关闭未来调度并执行 cancellation、reconciliation 和 replan/block。

未知字段、插件自定义能力或无法证明为单调放宽的 diff 一律归入安全收紧；Schema 默认拒绝未声明字段。

Policy patch 不接受 secret，只接受 `credentialRef`。Revision CAS 失败返回 `POLICY_REVISION_CONFLICT`。

### 4.7 Operation Query

```text
GET /v2/threads/{threadId}/operations
GET /v2/threads/{threadId}/operations/{operationId}
```

客户端可以按 status/kind 分页查询 Operation。Operation 是 Steer、Stop、Resume、Checkpoint Apply、Compaction、Policy Reconcile、Late Observation Reconcile、Model Invocation 和 Tool Invocation 的恢复与进度权威，不能要求客户端只靠事件猜测当前阶段。内部 invocation 使用 system command identity，但仍可在关联 Run 下查询。

### 4.8 Checkpoint 和 Snapshot

```text
GET  /v2/threads/{threadId}/checkpoints
POST /v2/threads/{threadId}/checkpoints/{checkpointId}/apply
GET  /v2/threads/{threadId}/snapshot
GET  /v2/threads/{threadId}/events
```

Checkpoint Apply 只允许在没有 active Run 和冲突性 workspace Operation 时开始；否则返回 `OPERATION_CONFLICT`。接受后创建持久 Operation 和特殊 Run，暂停 Queue，并遵循 workspace mutation 和 reconciliation 规则。它不是 Thread Resume 的隐式副作用。

## 5. Command Ack

异步命令在意图、Operation、Ledger、Outbox 和 Ack 已事务提交后立即返回：

```ts
type CommandAck<Result = undefined> = {
  commandId: string;
  operationId?: string;
  status: 'accepted';
  replayed: boolean;
  threadId: string;
  runId?: string;
  result?: Result;
  completionEvents?: string[];
  currentDurableCursor: string;
  acceptedAt: string;
};
```

- Ack 不表示 Steer、Stop、Policy Reconcile 或 Checkpoint Apply 已完成。
- 事务内已经完成的 Submission、Queue edit 或简单 metadata mutation 可以直接返回 `result`，不创建 Operation。
- 可能等待外部状态、跨越 crash 或需要 recovery 的命令必须返回 `operationId + completionEvents`。
- Resume 和 Undelete 为固定的可审计 Operation；即使同步完成也保留 `operationId`。
- 相同 client identity、相同 commandId、相同 payload hash 返回原 Ack，并设 `replayed: true`。
- 相同 commandId 携带不同 payload hash 返回 `COMMAND_ID_CONFLICT`。
- 验证或语义拒绝返回 `ApiError`，不返回另一套 rejected Ack。

`payloadHash` 由 Server 计算：对已验证的 command kind、route identity、path parameters 和移除 `commandId` 后的 body 做 canonical JSON 编码，再计算 SHA-256。Server 不接受客户端自报 hash；字段顺序或 JSON 空白差异不能改变 command identity。

## 6. Error Contract

```ts
type ApiError = {
  error: {
    code: ErrorCode;
    message: string;
    commandId?: string;
    threadId?: string;
    runId?: string;
    operationId?: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};
```

最低稳定 code：

```text
VALIDATION_ERROR
THREAD_NOT_FOUND
THREAD_ARCHIVED
THREAD_DELETED
THREAD_PURGE_STARTED
THREAD_NOT_IMMEDIATELY_RUNNABLE
RUN_NOT_FOUND
RUN_NOT_ACTIVE
RUN_ALREADY_TERMINAL
STALE_PLAN_GENERATION
STALE_INCARNATION
QUEUE_ITEM_NOT_FOUND
QUEUE_ITEM_ALREADY_CONSUMED
QUEUE_REVISION_CONFLICT
COMMAND_ID_CONFLICT
APPROVAL_EXPIRED
OPERATION_CONFLICT
CONFIG_REVISION_CONFLICT
POLICY_REVISION_CONFLICT
RUNTIME_DRAINING
RECOVERY_BLOCKED
INDETERMINATE_SIDE_EFFECT
AUTHENTICATION_REQUIRED
CREDENTIAL_UNAVAILABLE
INTERNAL_ERROR
```

HTTP 映射：400 validation，401 authentication，404 not found，409 stale/revision/terminal conflict，410 tombstone，422 command semantic conflict，503 lease/recovery/worker unavailable。

## 7. Event Model

### 7.1 Durable Semantic Event

- 由 Projection + Ledger + Event Outbox 同事务生成。
- 拥有 `durableSequence`，可跨 daemon 重启 replay。
- 示例：Run transition、Steer/Stop phase、Tool terminal、Approval、Queue、Thread lifecycle、Operation terminal。
- Outbox 是 durable live/replay 的唯一发布来源。Actor 在事务提交后只通知 EventMux drain 对应 Outbox sequence，不另外构造第二份 durable event。

### 7.2 Transient Stream Delta

- 只进入当前 incarnation 的 EventMux ring buffer。
- 拥有 `incarnationId + streamSequence`。
- 不承诺跨 daemon restart replay。
- 示例：assistant text/reasoning delta、tool stdout/stderr delta、短期 progress。

两种 sequence 属于独立空间，不比较大小。

```ts
type EventBase<T> = {
  eventId: string;
  threadId: string;
  kind: string;
  critical: boolean;
  occurredAt: string;
  runId?: string;
  planGeneration?: number;
  payload: T;
};

type DurableEventEnvelope<T> = EventBase<T> & {
  durability: 'durable';
  durableSequence: string;
  streamBasis?: {
    incarnationId: string;
    streamSequence: string;
  };
};

type TransientEventEnvelope<T> = EventBase<T> & {
  durability: 'transient';
  incarnationId: string;
  streamSequence: string;
  durableBasis: string;
};
```

`durableBasis` 是 transient frame 创建时已经提交的 durable high-watermark。EventMux 在向连接交付 transient frame 前，必须先确保该连接已交付至其 durableBasis。

`streamBasis` 是 durable semantic event 提交时已经产生、且与该语义转换存在因果关系的 transient high-watermark。例如 assistant/tool terminal event 必须带上完成前最后一个 text/stdout sequence。EventMux 在交付该 durable event 前，必须先让连接消费到同 incarnation 的 streamBasis。它不是第三套 cursor，也不允许拿来和 durableSequence 比较。

如果任一 causal basis 已被驱逐、来自无法拼接的 incarnation 或无法证明，服务端发送 Snapshot Reset，不得猜测顺序。与 runtime stream 无因果关系的 Thread metadata/Queue event 可以省略 streamBasis。

Basis 只能引用创建该 frame 之前已经存在的 high-watermark：transient 的 durableBasis 来自已提交 Outbox，durable 的 streamBasis 来自已分配 stream sequence。该时间规则必须保证因果图无环；检测到 cycle 视为 Server protocol error 并触发 reset/diagnostic。

公共 Zod schema 使用以 `kind` 为 discriminator 的有限 union。生成客户端还必须保留 `UnknownEventEnvelope` fallback，使较旧客户端可以推进 cursor、记录诊断并忽略不认识的非关键 kind，而不是让整个 stream parser 崩溃。标记为 `critical: true` 的未知事件必须触发 Snapshot Reset 或协议升级错误，不能静默忽略。

### 7.3 Event Attach

客户端连接携带：

```text
durableAfter
incarnationId
streamAfter
```

服务端可以提供 opaque resume token，但内部语义仍是上述三项。单个 SSE `Last-Event-ID` 不承担两个 cursor 空间。

每次 attach 都建立 connection barrier：验证 Outbox retention 和 transient ring cursor，捕获两个 high-watermark；按 `durableBasis` 和 `streamBasis` 拓扑合并两个 backlog，最后切换 live。任一 cursor 或 causal basis 无效时不做部分拼接，直接发送 Snapshot Reset。

## 8. Snapshot Reset Barrier

`stream.snapshotReset` 是 Stream Control Frame，不占 durable 或 transient sequence。

```ts
type SnapshotReset = {
  kind: 'stream.snapshotReset';
  resetId: string;
  threadId: string;
  reason:
    | 'cursorExpired'
    | 'incarnationChanged'
    | 'daemonRestarted'
    | 'streamStateUnavailable'
    | 'runtimeNotLoaded';
  snapshot: ThreadSnapshot;
  durableCursor: string;
  incarnationId?: string;
  streamCursor?: string;
};

type ThreadStreamFrame =
  | DurableEventEnvelope<KnownDurablePayload>
  | TransientEventEnvelope<KnownTransientPayload>
  | SnapshotReset
  | UnknownEventEnvelope;
```

线性化协议：

1. Thread actor 处理 `CreateSnapshotBarrier`，生成 resetId。
2. EventMux 暂停该连接的 durable/transient 投递，并注册 post-barrier buffer。
3. Actor 记录当前 stream cutoff；后续 delta 继续产生，但进入该连接的 barrier buffer。
4. Actor 在不处理其他 Thread semantic message 的情况下，执行单一数据库 read transaction，读取 Thread/Run/Queue/Operation/Approval/Transcript Projection 和 durable high-watermark。
5. EventMux 返回截至 stream cutoff 的聚合 stream state。
6. Actor 组装 SnapshotReset 后立即释放 actor barrier；数据库 transaction 已关闭。
7. 网络层发送 SnapshotReset，再发送 durableSequence 和 streamSequence 分别大于两个 cursor 的 buffered frames。
8. 连接恢复正常投递。

网络 IO 失败不影响 Thread actor；不得在网络发送期间持有 actor barrier、workspace lock 或数据库 transaction。客户端收到 reset 后丢弃旧连接尚未应用的 frame，原子替换 state/cursors，再应用后续 frame。

Barrier buffer 必须有 byte/frame 上限和 deadline。超过限制时关闭该连接并要求重新 attach，不得通过阻塞 Thread actor实施背压。

Thread 没有 RuntimeSession 时 Snapshot Reset 只建立 durable boundary，省略 incarnationId/streamCursor；后续 RuntimeSession 建立新 incarnation 时再次发送 reset，客户端从空 transient buffer 开始。

`SnapshotReset.durableCursor` 必须等于内嵌 `snapshot.durableCursor`；存在 runtime 时，frame 和 snapshot 的 incarnationId/streamCursor 也必须完全一致。客户端发现不一致时按协议错误关闭连接并重新 attach，不能选择其中一份继续拼接。

Barrier 测试必须在 cutoff、read transaction、stream snapshot、reset enqueue 和恢复投递各阶段注入 durable/transient event，最终 reducer 与服务端 Snapshot + subsequent events 一致。

## 9. ThreadSnapshot

Snapshot 是有界客户端 Projection，不是 Ledger dump：

```ts
type ThreadSnapshot = {
  thread: ThreadView;
  activeRun?: RunView;
  recentRuns: Page<RunView>;
  queue: QueueView;
  pendingOperations: OperationView[];
  pendingApprovals: ApprovalView[];
  transcript: Page<TranscriptItemView>;
  toolExecutions: ToolExecutionSummary[];
  streamState?: StreamStateSnapshot;
  durableCursor: string;
  incarnationId?: string;
  streamCursor?: string;
  snapshotVersion: number;
};
```

StreamState 可以包含当前 incarnation 已聚合的 partial text/tool stream，并标记 `streaming | interrupted | completed`。daemon crash 后 Snapshot 最多恢复服务端最后持久的 coalesced draft，并以 `interrupted/daemonLost` 标记；draft checkpoint 之后的 token 可能丢失。无法恢复 transient state 时不得采用客户端缓存伪造服务端 Transcript，也不得把 partial output 标成 completed。

## 10. Client Reducer

TypeScript 提供唯一纯函数 reducer：

```ts
function reduceThreadFrame(
  state: ClientThreadState,
  frame: ThreadStreamFrame,
): ClientThreadState;
```

- Durable event 更新稳定 Projection。
- Transient delta 只更新匹配 incarnation 的 stream buffer。
- Snapshot Reset 整体替换 state 和 cursors。
- eventId 去重；旧 incarnation transient event 丢弃。
- React/Ink 组件不直接解释原始 event。

Swift 使用 actor 串行处理：

```swift
actor ThreadEventStore {
    private(set) var snapshot: ThreadSnapshot
    func apply(_ frame: ThreadStreamFrame) throws
}
```

`@MainActor` ViewModel 只观察 actor 输出，网络 callback 不直接修改 SwiftUI state。

## 11. Local Authentication

Loopback 和“同一 OS 用户”都不是完整可信边界。Transport 优先使用当前用户权限保护的 Unix Domain Socket（macOS/Linux）或 Named Pipe（Windows），并校验 peer UID/SID；但 UDS/pipe 权限不能替代应用层认证。除最小 health/discovery 外，所有 transport 都必须建立 authenticated principal。

本地客户端使用系统凭据存储中的 installation credential，通过 Authorization header 或受保护 IPC metadata 发送；token 不进入 URL。`clientIdentity` 由认证 principal 派生并跨正常 token rotation 保持稳定，不能直接采用客户端 body/header 自报 ID。

使用 TCP loopback 时还必须满足：

- daemon 生成至少 256-bit 随机 bearer token。
- 所有非公开 health/discovery 请求强制 Authorization。
- 默认拒绝浏览器 Origin；CORS 仅允许显式 compatibility origin。
- token 不出现在 URL、Ledger、Outbox、Snapshot 或日志。

Discovery file：

```ts
type DaemonDiscovery = {
  endpoint: string;
  daemonInstanceId: string;
  tokenRef: string;
  protocolVersion: '2';
};
```

Discovery file 仅当前用户可读。真实 credential 存在 macOS Keychain、Windows Credential Manager 或 Linux Secret Service；生产构建使用 OS ACL/code-signing access control 限制读取者。重启轮换时允许极短 overlap；客户端 401 后重新 discovery。Remote worker 使用独立内部凭据，不能复用客户端 principal。

Discovery 同时用于 daemon singleton 协调：客户端或第二个启动器必须优先连接已持有数据目录 instance lock 的 daemon，不得自行启动第二个 control plane。

## 12. Provider 和 Plugin Credentials

公共和持久状态只保存：

```ts
type CredentialRef = {
  credentialRef: string;
  provider: string;
  label: string;
  createdAt: string;
};
```

daemon 通过系统 Credential Broker 解析引用。客户端不能读取原始 secret；删除 credential 触发 Policy Reconcile。任何 request/response/event 日志都必须执行 secret redaction。

2.0 不提供经 REST/SSE 上传、导出或读取 secret 的接口。Ink CLI 和 SwiftUI 调用同一个 Rust 原生 Credential Broker 将 secret 写入系统凭据存储，只把返回的 `credentialRef` 交给 Config/Policy Command；TypeScript daemon 通过同一 broker 的受认证 IPC 解析。

Broker 删除 credential 时向 daemon 发送不含 secret 的 revocation notification；daemon 为所有引用该 ref 的 Thread 创建安全 Policy Reconcile。daemon 离线或通知丢失时，Startup/Resume credential availability reconciliation 必须补做同样处理。生产构建不得回退到数据库或明文配置文件保存 secret。

## 13. Compatibility Adapter

旧客户端通过独立 adapter 翻译旧 request/response、历史快照和事件形状：

- Adapter 返回 `Deprecation`、`Sunset` 和 successor `Link` headers。
- Adapter 不伪造 RuntimeSession、旧模型流、进程或 transient cursor。
- Adapter 不长期双写两套 Projection。
- 无法等价映射的行为返回明确兼容性错误。
- Adapter 在迁移窗口结束后删除。

## 14. Contract 不变量

| 编号              | 不变量                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| CONTRACT-API-001  | 普通 Submission 不能绕过已有 Queue。                                      |
| CONTRACT-API-002  | Resume、Unarchive、Undelete 和 Checkpoint Apply 是不同命令。              |
| CONTRACT-CMD-001  | Ack 只表示命令已持久接受，不表示异步完成。                                |
| CONTRACT-CMD-002  | command identity 由 client identity、commandId 和 payload hash 共同定义。 |
| CONTRACT-CFG-001  | Config Change 不隐式修改当前 generation 的 model config snapshot。        |
| CONTRACT-POL-001  | 当前 generation 不得因能力放宽而获得其 policy snapshot 之外的新权限。   |
| CONTRACT-EVT-001  | Durable 和 transient cursor 独立推进，不比较大小。                        |
| CONTRACT-EVT-002  | Snapshot Reset 不占用任一事件序列。                                       |
| CONTRACT-EVT-003  | Snapshot barrier 后客户端状态等于 Snapshot 加 subsequent events。         |
| CONTRACT-EVT-004  | Transient event 不能跨 incarnation 拼接。                                 |
| CONTRACT-EVT-005  | Durable/transient frame 必须满足双向 causal basis 后才能交付。             |
| CONTRACT-AUTH-001 | Loopback 请求不能绕过认证。                                               |
| CONTRACT-AUTH-002 | Secret 不得进入公共或持久语义数据。                                       |
| CONTRACT-AUTH-003 | clientIdentity 由认证 principal 派生，客户端不能自报或借 token rotation 改写。 |

## 15. 验收标准

- OpenAPI、JSON Schema、TypeScript 和 Swift fixture 由同一 Zod source 生成。
- 每个 ErrorCode、CommandAck 和 Operation terminal path 有 conformance test。
- Snapshot barrier 通过可控 barrier 并发测试。
- TypeScript reducer 和 Swift actor 使用相同 golden event fixtures。
- Auth 测试覆盖无 token、错误 token、轮换、Origin 和日志脱敏。
- Compatibility Adapter 使用独立 contract tests，不污染 2.0 schema。
