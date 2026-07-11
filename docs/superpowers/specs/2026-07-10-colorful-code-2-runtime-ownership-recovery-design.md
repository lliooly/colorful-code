# Colorful Code 2.0 Runtime Ownership and Recovery

> **Status: Normative**
>
> 本文档定义 Thread actor、EventMux、Operation 执行、锁与等待规则、Thread Lease、Fencing、Drain、Late Observation、Policy Reconcile 和 Crash Recovery。

## 1. 依赖与目标

- [Core Architecture](./2026-07-10-colorful-code-2-core-architecture-design.md) 定义实体和不变量。
- [Persistence Foundation](./2026-07-10-colorful-code-2-persistence-foundation-design.md) 定义事务和恢复表。
- [Thread Contract](./2026-07-10-colorful-code-2-thread-contract-design.md) 定义公共 API 和 Snapshot barrier。

本规范回答：谁有权执行 Thread、谁有权提交状态、owner 丢失后如何阻止旧执行继续，以及如何从持久事实和现实状态恢复。

## 2. 三条横切规则

1. **Thread actor 是 Thread 语义消息的唯一串行化入口。**
2. **所有长时间等待都转成持久 Operation 状态，不在锁或数据库事务中等待。**
3. **Command、Operation、Projection、Ledger 和 Outbox 构成可恢复闭环。**

模型、工具、MCP、Watcher、网络 callback 和 Outbox publisher 不得直接修改 Thread Projection。它们只能向 actor 提交 message/observation。

允许绕过 actor 的写入仅限非业务语义控制面：Heartbeat CAS、Worker Registry heartbeat、Outbox publish metadata 和 Late Observation Inbox append。它们不得修改 Thread/Run/Queue/Operation/Tool/Approval Projection；Inbox resolution 仍必须由当前 Thread actor 和 lease holder 完成。

## 3. Thread Actor

### 3.1 责任

daemon 内每个正在处理语义命令或事件连接的 Thread 有一个 actor。Actor 可以处于 cold 状态而不创建 RuntimeSession；需要模型、工具或 Scheduler 执行时才按需装载 RuntimeSession。Actor 负责：

- 验证 Thread lifecycle、Lease fence、Run、Plan Generation、Execution Config Revision 和 Policy Revision。
- 串行化 Submission、Queue dispatch、Steer、Stop、Approval、Checkpoint Apply 和 Policy Reconcile。
- 执行短数据库 transaction。
- 创建/推进持久 Operation。
- 启动受控 executor task，并接收其 Observation。
- 通过内部 EventMux 发布 durable/transient frame。
- 建立 Snapshot barrier。

2.0 中 SQLite 和 Thread actor registry 只存在于单一本地 daemon control plane。Worker/remote sandbox 不持有数据库连接，只通过受认证内部通道接收 Dispatch Permit、提交 Observation。未来多 control-plane 的分布式 actor routing 不属于 2.0。

daemon 必须在打开业务数据库前获取数据目录级 interprocess instance lock，并持有到进程退出。第二个 daemon 读取 discovery 后连接现有实例，或明确退出；不得在同一数据库上创建第二套 Thread actor registry。OS crash 后 lock 自动释放，但新 daemon仍需执行 Lease takeover 和 recovery。

### 3.2 Actor 不持有长任务

Actor handler 允许：

- 纯内存状态转换。
- 短数据库 read/write transaction。
- 注册 child task 后立即返回 mailbox。
- 处理 child completion、timeout、cancel 和 late observation message。

Actor handler 禁止等待：

- Workspace lock。
- 用户 Approval。
- 模型、MCP、LSP 或网络响应。
- 工具完成、tool drain 或子进程退出。
- 文件系统操作。
- 向客户端写 socket。

`waitingForApproval`、`drainingTools`、`waitingForWorkspace` 和 `reconciling` 是 Operation phase，不是一直占住 actor 的 Promise。

### 3.3 Mailbox 优先级

同一 Run 的控制优先级：

```text
leaseLost / localFence
-> Stop
-> security-tightening Policy Reconcile
-> Steer
-> Approval / Tool Observation
-> normal Submission / Queue dispatch
-> maintenance / compaction
```

- Stop accepted 后，未 applied Steer 必须取消或按 stale policy 转 Queue。
- 安全收紧可以关闭未来调度，但不能把已经发生的副作用抹除。
- 高优先级消息不得永久饿死 cleanup；actor 每次只执行短 handler，并对同优先级保持 FIFO。

## 4. EventMux 和 Snapshot Barrier

Thread 的 durable semantic update 和 transient stream publish 都经过 actor 内部 EventMux：

- Durable update 先事务提交 Projection + Ledger + Outbox；Outbox 是唯一 durable 发布来源。Actor 在提交与当前 stream 有因果关系的 terminal/phase event 前捕获 EventMux high-watermark，并作为 `streamBasis` 写入 Outbox。Actor 只通知 EventMux 按 sequence drain Outbox，不另行构造一份 durable frame。
- Transient producer 只向 actor/EventMux 提交 delta，不直接写 socket。
- Outbox publisher 可以并发读取数据库，但 live delivery 必须进入 Thread EventMux。
- EventMux 双向执行 causal gate：transient 等待其 `durableBasis`，durable 等待其可选 `streamBasis`。任一 basis 无法满足时触发 Snapshot Reset，不能只保证单向顺序。
- stream sequence 分配、ring buffer append 和聚合 snapshot 由 EventMux 的单一串行 lane 完成；producer 不能直接修改 ring。Basis 只引用创建 frame 前已存在的 cursor，因此不能形成等待环。
- EventMux 可以按受限 byte/time threshold 向 actor提交聚合 draft checkpoint；actor 使用短 transaction 更新 `transcript_drafts`。Checkpoint 不占 durable event sequence，也不进入 Model Context；Steer/Stop barrier 仍以完整内存 buffer 为准。

Snapshot Reset：

1. 为目标连接注册 barrier buffer，暂停其 frame 投递。
2. Actor 记录 transient stream cutoff。
3. Actor 在一个 mailbox linearization point 内执行数据库一致性读，取得 Projection 和 durable high-watermark。
4. EventMux 提供 cutoff 对应的聚合 stream state。
5. Actor 组装 reset，释放 barrier；之后产生的 frame 已进入连接 buffer。
6. 网络层先发送 reset，再按两个 cursor 发送 buffered frame。

网络发送不占住 actor。断开的连接丢弃自身 barrier buffer，不影响 Thread。
每个 connection barrier 有独立 byte/frame 上限和 deadline；溢出时只关闭该连接，不能阻塞 Thread actor或其他 subscriber。

## 5. Operation 执行闭环

所有长命令使用 `operations` Projection：

```text
accepted  -> executing | completed | cancelled
executing -> waiting | blocked | completed | failed | cancelled
waiting   -> executing | blocked | failed | cancelled
blocked   -> executing | failed | cancelled
```

不需要外部协调的 Resume/Undelete 可以在一个事务内记录 accepted 和 completed facts；其他 Operation 不得用直接 completed 绕过持久 phase 与 recovery branch。

Command transaction 同时保存：

- command identity 和 payload hash。
- Operation 当前状态和 phase。
- 目标 Thread、Run、Generation、Execution Config Revision 和 Policy Revision。
- Ledger Fact、Outbox event 和原 Ack。

Crash Recovery 直接查询非终态 Operation，不依赖全量 Ledger replay。

最低 Operation kind：

- `steer`
- `stop`
- `checkpointApply`
- `compaction`
- `policyReconcile`
- `threadResume`
- `threadUndelete`
- `threadArchive`
- `threadDelete`
- `lateObservationReconcile`
- `modelInvocation`
- `toolInvocation`

Compaction 可以服务于一个 active Run，但必须与该 Run 的模型调用、工具调度、Checkpoint Apply 和 Steer/Stop reconciliation 互斥。开始时关闭该 Run 的 scheduling gate，完成时创建不可变 summary ContextItem + ContextBoundary，并原子更新 Plan Generation 的 current boundary pointer；它不创建第二个 Run。自动 compaction 也必须创建 Operation，不能作为 fire-and-forget task 修改 Context。

每次模型请求创建 system `modelInvocation` Operation，并在 accepted transaction 锁定 `inputContextBoundaryId`；流结束后 completed/failed/cancelled，crash 后不恢复旧 stream，而由 Run Recovery 决定是否在新 boundary 上创建新 invocation。每次工具动作创建 system `toolInvocation` Operation 并由 ToolExecution 引用；Approval wait、Workspace wait、execution、cancellation 和 indeterminate 都是该 Operation 的持久 phase。

Invocation Operation 通过 `parentOperationId` 构成同 Thread 无环树。Stop/Steer/Policy/Checkpoint cancellation 沿当前 operation tree 向下传播；child 的迟到 terminal fact 进入正常 Observation/Late Observation 流程，不能直接修改 parent terminal intent。

### 5.1 Operation 协调与合流

同一 Thread 可以保留多个逻辑 Operation 以满足幂等查询和审计，但同一 Run 任一时刻最多执行一个物理 quiesce/drain/reconciliation cycle。该 cycle 由 actor 内部 coordinator single-flight 管理，不通过持有 mutex 等待外部任务：

- Stop 到达时，原子写入 stopping intent；未 applied Steer 按 `reject | enqueue` stale policy cancelled/failed 或复用其未提交 Context 的 InputItem 转为队尾 QueueItem，Compaction cancelled。
- 安全 Policy Reconcile 与 Stop 同时存在时，共用当前 reconciliation facts。Stop terminal intent 不得被 policy replan 重新打开；policy revision 仍对未来 Run 生效。
- 安全 Policy Reconcile 到达 Steer 期间时，立即收紧 fence，并把 Steer Input 保留给同一次 reconciliation 后的新 generation；不得并行启动第二次 tool drain。
- target config/policy snapshot 相同的多个 Steer 可以加入同一 coordination cycle，按 accepted 顺序形成一个新 generation；不同 snapshot 不得以 last-write-wins 合并。
- Steer 在 Stop intent 已存在时不得 applied；已接受 Steer 只能按 stale policy 转 Queue/completed 或 cancelled，新的 Steer request 直接返回 `RUN_NOT_ACTIVE` 或 `OPERATION_CONFLICT`。
- Checkpoint Apply 在任何 active Run 或冲突性非终态 Operation 存在时拒绝。
- 每个合流 Operation 分别写 terminal result 和 evidence reference，不能因为共享 cycle 而丢失 command lifecycle。

## 6. 锁与等待规则

### 6.1 禁止危险嵌套

SQLite transaction 内禁止：workspace lock、文件/网络/进程、Approval、tool execution、sleep、actor RPC 和外部 await。

Workspace lock 内禁止：SQLite transaction、等待 Approval、同步 actor RPC、tool drain、网络请求和后台进程等待。

Actor mailbox handler 内禁止：等待 workspace lock、Approval、tool completion、network/process 或 socket write。

### 6.2 唯一执行链

```text
Thread actor
  -> short DB transaction: persist intent
  -> create cancellable dispatch permit
  -> start executor task and return mailbox

Executor task
  -> acquire workspace locks when required
  -> validate unexpired local dispatch permit
  -> perform bounded local side effect
  -> release workspace locks
  -> submit Observation to actor

Thread actor
  -> short DB transaction: persist Observation / Projection / Ledger / Outbox
```

### 6.3 Workspace Lock

- Key 使用 canonical workspace identity + canonical path。
- 多路径 lock 按全局 lexical order 一次获取；失败或 timeout 时全部释放。
- Approval 在获取 mutation lock 前完成；获取 lock 后重新检查 base revision/hash。
- 单文件写在 lock 内使用 temp file + atomic rename。
- 长后台进程不能持有 Workspace lock；它必须声明可能影响的范围，并通过 watcher/reconciliation 观察结果。
- 所有 lock wait 都支持 timeout 和 cancellation。
- Lock holder 不同步回调 actor 或上层组件。

### 6.4 Dispatch Permit

Tool intent transaction 验证 Lease fence，并生成绑定以下身份的短期 permit：

```text
permitId
targetWorkerId
threadId
runId
incarnationId
leaseEpoch
planGeneration
executionPolicyRevision
toolExecutionId
attemptId
issuedAt
permitExpiresAt
authTag
```

Executor 在实际副作用前再次检查 permit、local fencing flag 和 cancellation。等待 Workspace lock 导致 permit 过期时，executor 必须释放 lock 并请求 actor重新授权，不能继续执行旧 intent。

`permitExpiresAt` 必须早于或等于当前 Lease expiry 减去 safety margin，且 takeover grace 必须大于最大 permit lifetime。Permit 表示 takeover 前已经授予的有限执行权；过期 permit 永远不能续用。对于支持外部 fencing/idempotency token 的系统，必须同时提交 `toolExecutionId` 派生的 token。

Permit 由 daemon control plane 在受认证内部通道上签发，并使用 daemon incarnation 的 MAC/signature key 生成 `authTag`；key 不写 Ledger/Outbox/日志。Worker 必须校验 target identity、完整字段、expiry 和 authTag。一个 permit 只能用于一个 Attempt，Observation 必须回传 permitId；重复回传按 Observation idempotency 处理，不能再次执行副作用。

## 7. Worker、Incarnation 和 Lease

### 7.1 身份

- `daemonInstanceId`：daemon 进程身份。
- `workerId`：执行进程或节点身份。
- `incarnationId`：worker 对某 Thread 的一次加载。
- `leaseEpoch`：数据库单调 ownership fence。
- `planGeneration`：Run 内规划 fence。

Lease 绑定 Thread，不绑定 Run。它同时保护 active Run、Queue scheduler、Approval resolver 和所有 RuntimeSession resources。

### 7.2 Lease Projection

`threads.lease_epoch_counter` 永久单调递增；`thread_leases` 只保存当前 owner：

```text
thread_id PK
worker_id
incarnation_id UNIQUE
lease_epoch
state: active | draining
acquired_at
heartbeat_at
expires_at
drain_deadline?
```

Release 可以删除当前 Lease row，但不能重置 Thread epoch counter。

### 7.3 Fence

所有执行相关 Projection mutation和新副作用 intent 必须验证：

```text
threadId
workerId
incarnationId
leaseEpoch
expiresAt > databaseNow
```

Run/Tool mutation 继续验证 Plan Generation、该 generation 的 effective policy snapshot、ToolExecution 和 Attempt identity。数据库影响行数为 0 表示 fence rejected。

Policy fence 不能简单写成 `generation.policyRevision === thread.currentPolicyRevision`：纯放宽后，当前 generation 仍可在旧 snapshot 下执行，但不得使用新增能力；安全收紧后，旧 revision 只能提交 Observation，不能获得新 Dispatch Permit、Approval 或 credential resolution。

Thread create、archive、unarchive、undelete、tombstone metadata 和纯 Queue enqueue/reorder 由单 daemon Thread actor + revision CAS 串行化，不要求先创建 RuntimeSession。它们不得创建 Run、解决 Approval 或提交副作用。Archive/Delete 在存在 active Run 或冲突性 workspace Operation 时必须拒绝；成功后 Queue control state 变为 `pausedByUser`，恢复 lifecycle 时不自动 resume。Indeterminate blocker 是独立 Projection，不能覆盖 control state。

Archive/Delete 遇到 idle Lease 时不能直接改 lifecycle：Actor 创建 `threadArchive | threadDelete` Operation，关闭调度并执行 handoff-style drain；只有 release CAS 成功后才能提交 archived/tombstone。Drain 失败或 ownership 改变时 Operation 进入 recovery/blocked，不能让旧 runtime 对非 available Thread 继续续租。

该 Operation 非终态期间 Thread actor 设置 closing gate，拒绝 Submission 和所有 Queue mutation。只读 Query、Operation Query 和完成 drain/recovery 所需的内部消息仍可处理。

## 8. Acquire、Heartbeat 和 Takeover

### 8.1 Acquire

短 `BEGIN IMMEDIATE` transaction：

1. 验证 Thread `available`。
2. 使用数据库时钟读取当前 Lease。
3. 无 owner，或达到 takeover 条件时，递增 Thread epoch counter。
4. 生成新 incarnation，写 owner Projection；用户 Resume 始终同时写 `threadResume` Operation、Ledger、Outbox 和 Ack，Operation 可以在无需协调时于同一事务完成。
5. Commit 后 Runtime 进入 `loading -> recovering`，不能直接 running。

用户 Resume 遇到有效 owner 时复用/路由现有 owner，不暴露 worker location。内部 claim 遇到有效 owner 返回内部 `LEASE_HELD`。

### 8.2 Heartbeat

Heartbeat 独立于 Thread mailbox，使用 CAS：

```text
identity/epoch match
AND expiresAt > databaseNow
-> update heartbeatAt/expiresAt
```

- Heartbeat 不写高频 Ledger/Outbox。
- `leaseTtl >= heartbeatInterval * 3`。
- `busy_timeout` 和最大 transaction duration 必须小于 Lease 安全余量。
- 已过期 Lease 不能原地续命；必须以新 epoch/incarnation 重新 acquire。
- daemon 只有在 owner worker/in-process RuntimeSession 提供新鲜 liveness 证据时才能续租对应 Thread Lease；daemon 进程仍活着不能代替 worker liveness。
- Worker heartbeat 超过 policy deadline、内部通道断开或 worker process 被确认退出时，daemon 立即关闭该 incarnation 的 scheduling gate、停止 Lease 续租并启动 local fencing。它仍不能据此断言旧副作用已经停止。

### 8.3 Local Fencing

Heartbeat CAS 失败、epoch 改变、显式 revoke 或本地确认 Lease 到期时：

```text
schedulingOpen=false
invalidate dispatch permits
abort model stream
cancel scheduled tools
detach approvals
request cooperative cancellation for running tools
release local resources
```

旧 owner 不得更新主 Projection。它只能向 Late Observation ingress 提交事实并写本地日志。

### 8.4 Takeover

- `expiresAt` 到达后旧 owner立即失去写入权。
- `takeoverGrace` 只延迟新 owner acquire，不延长旧 owner权限。
- 新 worker 仅在 `expiresAt + grace < databaseNow` 时 CAS takeover。
- Takeover 先提交新 epoch/incarnation，再开始 recovery。

Lease timeout 不证明旧 worker 已停止；已经开始的现实副作用必须 reconciliation。

## 9. Steer、Stop 和 Approval

### 9.1 Steer

```text
accepted
-> quiescing
-> reconciling
-> applied | failed | blocked
```

- 立即停止模型流、冻结新调度、取消 scheduled tools、协作取消 running tools。
- 等待通过 Operation phase 表达；actor 不阻塞。
- Reconcile 后在同一 Run 内递增 Plan Generation。
- 截断的 assistant 文本进入 Transcript，不进入下一代 Context。
- Owner 丢失时，Steer Operation 由新 owner继续、按 stale policy 入队或 blocked，不能消失。

### 9.2 Stop

- Accepted transaction 先暂停 Queue、创建 Operation 和 stopping intent。
- Stop 优先于尚未 applied 的 Steer。
- Tool drain/reconcile 后 Run 进入 `stopped` 或 `blocked`。
- Owner 丢失时，新 owner在 recovery 中继续完成 Stop intent。

### 9.3 Approval

Approval 绑定 Thread、Run、Plan Generation、Policy Revision、Lease Epoch 和 Approval revision。Takeover、Generation 或安全 Policy Revision 改变后旧 Approval expire；需要继续动作时创建新 Approval。

## 10. Execution Config 和 Policy Reconcile

Execution Config Change 只更新后续 Run 默认值。当前 generation 继续使用自身 immutable model config snapshot，不关闭 scheduling gate，也不使旧 callback stale。若用户要在当前 Run 应用新 model/provider config，必须显式 Steer；Steer accepted 时捕获 target config revision，之后到达的普通 Config Change 不改变该次 Steer 的 generation。Recovery 和安全 Policy Reconcile 默认继承旧 model snapshot。

Thread 维护单调 `executionPolicyRevision`。

Server 根据 canonical old/new policy diff 分类，客户端不能声明分类。Mixed change 按安全收紧处理。

能力放宽：创建新 revision；当前 Plan Generation 继续按照自身不可变 effective policy snapshot 执行，新增能力仅对下一 Plan Generation 生效，不自动批准旧 Approval，也不使旧 generation 因 revision 不相等而失败。

安全收紧创建 `policyReconcile` Operation：

```text
policy revision++
-> close scheduling gate
-> cancel scheduled tools
-> expire affected approvals
-> request cancellation for running tools
-> reconcile actual effects
-> increment planGeneration and replan
   or block Run
```

安全收紧包括：禁用/删除插件、撤销 trust、收紧 sandbox/workspace、删除 credential、收紧 network policy。旧 revision callback 可以形成 Observation，但不能调度、复用 Approval 或覆盖当前 Plan Projection。

Checkpoint Apply 是独占 workspace mutation Operation。Actor 只有在无 active Run 和冲突性 workspace Operation 时才能接受并创建其特殊 Run；不允许通过等待当前工具结束来长期占住 actor handler。

## 11. Graceful Drain

Drain mode：

- `finishCurrentRun`：不创建新 Run、不消费 Queue，允许当前 Run 在 deadline 内完成后 release。
- `handoff`：立即冻结调度，协调工具和状态，持久化 handoff facts 后 release。

Draining 期间：

- 可以持久化 QueueItem，但不调度。
- Stop 可以继续处理。
- 新 Steer 返回 `RUNTIME_DRAINING`。
- Heartbeat 继续续租，直到安全 release 或 deadline。

Deadline 到达后旧 owner停止续租并 local fence。停止续租不代表 handoff 成功，新 owner仍需 takeover + recovery。

## 12. Late Observation Inbox

非当前 owner 只能 append inbox：

```text
sourceIncarnationId
sourceLeaseEpoch
toolExecutionId?
attemptId?
kind
canonicalPayloadHash
-> dedupKey
```

- Payload 先通过版本化 schema、来源认证和 canonical hash。
- Inbox receive 不更新 Projection。
- 当前 owner在短 transaction 中判为 accepted、rejected 或 conflict。
- Accepted 写 Ledger Fact，并在证据充分时更新 Projection。
- Conflict 触发 `lateObservationReconcile` Operation；例如本地显示 cancelled，但远端实际部署成功，不能简单丢弃。Tool outcome 先转为 indeterminate，Queue 设置独立 blocker，再由证据解析成新的 settled outcome。Terminal Run 的事后冲突还会把 active control state 降为 `pausedByFailure`。
- 非终态 Run 可以进入 recovering/blocked；终态 Run 不重新打开，只追加 post-terminal correction reference 和 durable event。
- 只有不存在其他 critical indeterminate 时才能清除 blocker；清除 blocker 不修改 Queue control state。

旧 incarnation 不能直接把 ToolExecution 写成 terminal。

## 13. Crash Recovery

新 owner acquire 后：

1. 保持 runtime scheduling gate 关闭。
2. 读取 Thread、active Run、Queue、非终态 Operation、ToolExecution、Approval 和 Inbox。
3. 校验 Schema、Lifecycle、Workspace binding、Policy Revision 和 credential availability。
4. Expire 旧 Approval，作废未提交 proposal。
5. 将旧 incarnation 的最后持久 assistant draft 标为 interrupted/daemonLost；不推断 checkpoint 后 token。
6. 按 Tool capability 查询 remote reference、文件 hash、进程事实或标记 indeterminate。
7. 处理 Inbox；冲突进入 reconciliation。
8. 重采集相关 Workspace fingerprint、Git branch/HEAD/dirty summary。
9. 在一个 transaction 中提交 facts、Projection、Operation、Ledger、Outbox 和 recovery decision。
10. 决策为 `continue | stop | fail | block`，携带 reason 和 evidence references。
11. Continue 时递增 Plan Generation，并默认继承上一 generation 的 model config snapshot；关键不确定性设置独立 Queue blocker，其他结果保持 Queue control state，不得覆盖既有 `pausedByStop` 或 `pausedByUser`。
12. Recovery completed 后才允许 Runtime ready/active 和 Queue dispatch。

Checkpoint Apply、Policy Reconcile、Steer 和 Stop 都必须有对应 crash branch。

## 14. Worker Registry 边界

Worker Registry 只提供 capability/liveness 辅助，不代表 Thread ownership。2.0 SQLite 由 daemon 统一持有；remote sandbox/worker 通过受认证内部通道提交 heartbeat 和 Observation，不直接共享本地 SQLite 文件。

Worker Registry 的 fresh heartbeat 是 Lease renewal 的必要条件之一，但不是 ownership 充分条件；只有 `thread_leases` CAS 能证明 owner。Registry expired 触发停止续租和 local fencing，不能直接把其他 worker写成新 owner。

RuntimeSession 不建立 ownership 主表。可选 Runtime Incarnation 记录只用于诊断；当前 `thread_leases` 行和 Thread epoch counter 是唯一 ownership 权威。

## 15. Runtime 不变量

| 编号               | 不变量                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| RUNTIME-ACTOR-001  | 所有 Thread semantic mutation 通过 Thread actor。                           |
| RUNTIME-ACTOR-002  | Actor handler 不等待外部 IO、锁、Approval、Tool 或 socket。                 |
| RUNTIME-ACTOR-003  | 同一数据目录最多一个 daemon control plane 和 Thread actor registry。        |
| RUNTIME-LOCK-001   | SQLite transaction、Workspace lock 和 Actor wait 不发生危险嵌套。           |
| RUNTIME-LOCK-002   | 多路径 Workspace lock 按 canonical path 全局排序。                          |
| RUNTIME-LOCK-003   | 所有 lock wait 有 timeout/cancellation，holder 不同步回调上层。             |
| RUNTIME-LEASE-001  | 同一 Thread 最多一个有效 owner。                                            |
| RUNTIME-LEASE-002  | 过期 Lease 不能续命，Takeover 先 fencing 后 recovery。                      |
| RUNTIME-LEASE-003  | 旧 owner只能提交 Late Observation。                                         |
| RUNTIME-OP-001     | 所有长等待都有持久 Operation phase 和 crash branch。                        |
| RUNTIME-OP-002     | 同一 Run 的 quiesce/drain/reconciliation cycle 必须 single-flight。         |
| RUNTIME-CONFIG-001 | Config Change 不改变当前 generation，也不隐式触发 replan。                  |
| RUNTIME-POLICY-001 | 安全收紧立即关闭未来调度并触发 reconcile。                                  |
| RUNTIME-POLICY-002 | 能力放宽不改变当前 generation 的不可变授权 snapshot。                       |
| RUNTIME-RECOV-001  | Late Observation 修正 Tool outcome 时不得重新打开 terminal Run。           |
| RUNTIME-EVENT-001  | Durable/transient delivery 通过 EventMux，Snapshot barrier 有单一线性化点。 |

## 16. 验收测试

### Ownership/Fencing

- 两个 worker 同时 acquire，同一时刻只有一个成功。
- 有效 Lease 不可 takeover；过期 Lease 单赢家 takeover。
- 旧 owner heartbeat、Run、Queue、Approval、Tool commit 全部被 fence。
- daemon 存活但 owner worker 崩溃时不再续租 Thread Lease，并最终进入单赢家 takeover/recovery。
- Lease 到期和 macOS sleep/wake 使用可控数据库 Clock 测试。

### Lock/Actor

- Actor 在模型、Tool、Approval 和 Workspace lock 等待期间继续处理 Stop/Lease Lost。
- 多路径反向请求不死锁。
- Transaction callback 无外部 await/side effect。
- Heartbeat 不依赖 actor mailbox，长任务不导致无意 Lease 失效。
- Stop、Steer、Policy Reconcile 同时到达时只执行一次物理 drain/reconcile，所有 Operation 各自进入正确终态。

### Snapshot/Event

- 在 barrier 每个阶段注入 durable/transient frame，无重复、无遗漏。
- assistant/tool terminal durable event 不得越过其最后一个 text/stdout transient delta；transient 也不得越过 durableBasis。
- 连接在 reset 前后断开，不阻塞 actor或泄漏 buffer。
- 旧 incarnation delta 被 reducer 丢弃。

### Crash/Recovery

- Tool effect 完成但 Observation 未提交。
- Stop/Steer accepted 但未完成。
- Policy Revision 变化时 running Tool 返回。
- Config Revision 变化时当前 generation 仍按旧 snapshot 正常完成；后续 Steer 使用新 config。
- Queue dispatch transaction、Outbox publish、Checkpoint Apply 各阶段 crash。
- Inbox duplicate、一致、冲突、无对应 Tool 和 unsupported reconciliation。
- 终态 Run 收到冲突事实后 status/endedAt 不变，Tool correction、Operation 和 Queue blocker 可见且可恢复。

### Drain

- finishCurrentRun、handoff、deadline timeout。
- Drain 期间 Queue、Stop、Steer 和 owner loss。

## 17. 实现顺序

```text
ThreadActor skeleton + deterministic mailbox tests
-> EventMux + Snapshot barrier tests
-> Lease CAS + Heartbeat + Local Fencing
-> Operation runner + persistent waiting phases
-> Workspace Coordinator + Dispatch Permit
-> Late Observation Inbox
-> Takeover + Recovery Coordinator
-> Policy Reconcile
-> Graceful Drain
-> full failure-injection matrix
```
