# Colorful Code 2.0 Core Architecture

> **Status: Normative**
>
> 本文档定义 Colorful Code 2.0 的实体、所有权、状态机、权威关系和系统级不变量。其他 2.0 规格与本文冲突时，以本文为准。

## 1. 目标

Colorful Code 2.0 是一个 Headless Agent Core 加多个本地客户端的系统：

- TypeScript 负责 Agent loop、模型适配、工具协议、权限、MCP/LSP、Thread 和持久化语义。
- Rust 负责原生进程、PTY、系统沙箱、文件监听、桌面 sidecar、签名和更新。
- Ink、SwiftUI 和未来 WinUI 只消费同一套公共 Contract，不复制 Agent 业务逻辑。

本设计优先保证正确性、可恢复性和审计能力。2.0 不以多机吞吐量为目标；3.0 可以在不改变公共语义的前提下替换存储、worker 和 sandbox 实现。

## 2. 规范文档

- 本文：实体、状态机、全局不变量。
- [Persistence Foundation](./2026-07-10-colorful-code-2-persistence-foundation-design.md)：SQLite、迁移、表、事务和 Outbox。
- [Thread Contract](./2026-07-10-colorful-code-2-thread-contract-design.md)：公共 API、事件、鉴权和客户端状态模型。
- [Runtime Ownership and Recovery](./2026-07-10-colorful-code-2-runtime-ownership-recovery-design.md)：Actor、Lease、锁、Drain 和 Crash Recovery。

## 3. 术语

| 术语                 | 定义                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Thread               | 用户长期可见、可恢复、可归档和可分叉的持久工作历史与调度容器。                               |
| Run                  | Thread 内一次具有明确起点和终点的执行。一次 Run 可以包含多次模型调用、工具循环和 Steer。     |
| Plan Generation      | Run 内一次规划世代。Steer、显式 replan 或安全 recovery 继续时递增。                          |
| Runtime Incarnation  | 某个 worker 对某个 Thread 的一次运行时加载。由 `incarnationId` 标识。                        |
| RuntimeSession       | Runtime Incarnation 对应的内存执行对象，不是公共资源或持久权威。                             |
| InputItem            | 不可变的用户、system、steer、automation 或 recovery 输入。                                   |
| QueueItem            | 指向 InputItem 的后续调度项。Queue 属于 Thread。                                             |
| Operation            | 可跨进程恢复的长命令状态机，例如 Steer、Stop、Checkpoint Apply、Resume 和 Policy Reconcile。 |
| TranscriptItem       | 用户实际看到的追加式记录。Transcript 不证明副作用已经发生。                                  |
| ContextItem          | 已提交、可以进入后续模型上下文的 canonical item。                                            |
| Ledger Fact          | 关键命令、状态转换、审批和副作用观察的不可变事实。                                           |
| Projection           | 为查询和调度维护的当前状态表。                                                               |
| ToolExecution        | 一个逻辑工具动作；重试时身份和幂等键保持不变。                                               |
| ToolExecutionAttempt | ToolExecution 的一次具体进程、网络或 transport 尝试。                                        |
| Workspace            | Thread 绑定的本地工作区和系统边界，不拥有业务 Queue。                                        |
| RetentionJob          | 独立于 Thread 行存活的持久 purge 状态机，用于幂等清理数据库历史和未共享 artifact。          |

## 4. 数据权威关系

```text
Immutable Inputs / Transcript / Ledger Facts
                    ↓
Thread / Run / Queue / Operation / Tool Projections
                    ↓
RuntimeSession / Model Stream / Process / MCP / Watcher
```

- Input 定义用户和系统输入的唯一身份。
- Transcript 定义用户看见了什么。
- Ledger 定义命令、状态转换和副作用事实。
- Projection 是高效查询和调度状态，不是独立事实来源。
- RuntimeSession 是可丢弃缓存和执行资源。
- 系统不采用完全事件溯源；关键 Projection、Ledger 和 Outbox 必须事务一致。

## 5. 实体所有权

### 5.1 Thread

Thread 持久拥有：

- Input、Transcript、Context 和 Run 列表。
- Queue、Queue control state、indeterminate blocker 和 Queue revision。
- Operation、Approval、Permission 和 Tool audit。
- artifacts、compaction summaries、checkpoint references。
- workspace binding、lineage、goal 和默认策略配置。
- `executionConfigRevision`、`executionPolicyRevision` 和 `leaseEpochCounter`。

Thread 不拥有：

- 进程句柄、AbortController、Promise 或模型流。
- MCP/LSP transport、socket、watcher 或内存 context cache。
- 明文模型、插件或客户端凭据。

### 5.2 Run

Run 从 `starting` 开始，不存在排队状态。排队事实只由 QueueItem 表达。

Run 包含：

- 触发 InputItem 或来源 QueueItem。
- 当前 `planGeneration`、`executionConfigRevision` 和 `executionPolicyRevision`。
- ToolExecution、Approval、Operation 和 terminal summary 引用。
- `startedAt`、`endedAt` 和结构化 terminal reason。

### 5.3 Thread Actor

Thread actor 是 daemon 控制面的语义串行化对象，按需创建，可以在没有 RuntimeSession 时处理 Queue、生命周期和只读查询。Thread actor 拥有或管理 RuntimeSession，而不是由 RuntimeSession 反向拥有 actor。

2.0 只有一个持有 SQLite 的本地 daemon control plane；remote worker/sandbox 只执行已授权任务并提交 Observation，不直接写数据库。未来多 control-plane 部署不属于 2.0 范围。

### 5.4 RuntimeSession

RuntimeSession 持有：

- model client、MCP/LSP connections、sandbox 和 watcher。
- active Run task、structured concurrency scope 和 cancellation tree。
- transient execution resources、model/tool streams 和 worker-local cache。
- 当前 Thread Lease。

RuntimeSession 结束不代表 Thread 结束。

## 6. 状态机

### 6.1 Thread Lifecycle

```text
available -> archived -> available
available -> deleted -> available
deleted -> purged
```

持久状态：

```ts
type ThreadLifecycle = 'available' | 'archived' | 'deleted';
```

- `deleted` 是 tombstone，不是即时物理删除。
- `purged` 是 GC 结果，不是可查询 Thread 状态。
- Purge 一旦进入持久 `retentionJob.executing` 就冻结 Undelete；Purge crash 只能续跑或进入 failed/manual recovery，不能把已删除 artifact 伪装成可恢复 Thread。
- Runtime loading/running 不进入 Thread Lifecycle。
- Archive 或 Delete 只允许在不存在 active Run 和冲突性 workspace Operation 时执行；否则必须先显式 Stop 并完成 reconciliation。若仍有 idle RuntimeSession/Lease，命令创建持久 `threadArchive | threadDelete` Operation，先关闭调度、drain 并 release Lease，再提交 lifecycle。
- 进入 `archived` 或 `deleted` 时 Queue 保留，但 control state 原子变为 `pausedByUser`。Unarchive 或 Undelete 不自动恢复消费，必须由用户显式 Queue Resume。

### 6.2 Thread Runtime Status

```ts
type ThreadRuntimeStatus =
  | 'notLoaded'
  | 'loading'
  | 'idle'
  | 'running'
  | 'recovering'
  | 'blocked';
```

这是运行时 Projection，不是 Thread 历史生命周期。
它由 Lease、active Run、非终态 Operation 和当前 RuntimeSession 共同派生，不建立可被独立修改的权威 `threads.runtime_status` 列。持久事实与内存状态不一致时，以持久事实和 recovery 结果为准。

### 6.3 Queue Dispatch Model

```ts
type QueueControlState =
  | 'active'
  | 'pausedByUser'
  | 'pausedByStop'
  | 'pausedByFailure';

type EffectiveQueueDispatchState =
  | QueueControlState
  | 'blockedByIndeterminate';
```

`blockedByIndeterminate` 是独立持久 blocker，不覆盖 QueueControlState。Effective state 先检查 blocker；blocker 清除后恢复原 control state。例如 Stop 后出现关键 indeterminate 时，effective state 为 `blockedByIndeterminate`，但 control state 仍为 `pausedByStop`，因此 reconciliation 完成后不会自动消费下一项。

### 6.4 QueueItem

```ts
type QueueItemStatus = 'queued' | 'consumed' | 'removed';
```

消费 QueueItem 与创建 `starting` Run 必须在同一事务完成。

### 6.5 Run

```text
starting   -> running | steering | stopping | failed
running    -> steering | stopping | recovering | blocked | completed | failed
steering   -> running | stopping | recovering | blocked | failed
stopping   -> stopped | blocked | failed
recovering -> running | stopping | blocked | failed
blocked    -> recovering | stopping | failed
```

Run 终态只有 `completed | failed | stopped`。`blocked` 是非终态暂停状态。

### 6.6 Operation

```ts
type OperationStatus =
  | 'accepted'
  | 'executing'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

```text
accepted  -> executing | completed | cancelled
executing -> waiting | blocked | completed | failed | cancelled
waiting   -> executing | blocked | failed | cancelled
blocked   -> executing | failed | cancelled
```

`completed | failed | cancelled` 是 Operation 终态，终态不可重新打开。
只有不需要外部协调、等待或副作用的 Operation 才能在接受事务内直接 `accepted -> completed`；该事务仍需写完整 Ledger/Outbox 事实。

所有可能跨越一次事件循环、进程重启或外部等待的命令都必须创建 Operation。至少包括：

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

### 6.7 ToolExecution

```ts
type ToolExecutionState =
  | 'scheduled'
  | 'running'
  | 'cancelRequested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'indeterminate';
```

```text
scheduled       -> running | cancelRequested | cancelled
running         -> cancelRequested | completed | failed | cancelled | indeterminate
cancelRequested -> completed | failed | cancelled | indeterminate
indeterminate   -> completed | failed | cancelled
completed       -> indeterminate  // 仅 verified conflicting fact
failed          -> indeterminate  // 仅 verified conflicting fact
cancelled       -> indeterminate  // 仅 verified conflicting fact
```

`indeterminate` 表示系统暂时无法证明副作用是否发生，不能被自动解释为失败或取消。它不是可自动清理的终态；只有 reconciliation 获得新证据后才能转成 settled outcome，否则关联非终态 Run 保持 blocked。

`cancelled` 只用于有肯定证据证明动作未执行或已按工具语义安全取消的情况。仅发送 cancellation request、超时、连接断开或旧 worker 消失都不足以写 cancelled，必须进入 `indeterminate`。

Tool settled outcome 可以被后来验证的冲突事实纠正，但只能先进入 `indeterminate` 并留下 Ledger correction chain。Run 的 `completed | failed | stopped` 终态永不重新打开：若冲突在 Run 终态后出现，系统创建 `lateObservationReconcile` Operation、设置 Queue indeterminate blocker，把原本 active 的 Queue control state 降为 `pausedByFailure`，并在旧 Run 上展示 post-terminal correction 引用。

## 7. Submission、Queue、Steer 和 Stop

### 7.1 Submission 公平性

公共 Submission disposition：

```ts
type SubmissionDisposition = 'auto' | 'enqueue' | 'requireImmediate';
```

- 所有 disposition 先验证 Thread lifecycle；`archived` 返回 `THREAD_ARCHIVED`，`deleted` 返回 `THREAD_DELETED`，不得向非 available Thread 写入 InputItem 或 QueueItem。
- 非终态 `threadArchive | threadDelete` 是 closing gate；期间所有 Submission 和 Queue mutation 返回 `OPERATION_CONFLICT`，不得 fallback 入队。
- `auto`：在 Thread available 的前提下，只有无 active Run、Queue 为空、control state active、无 indeterminate blocker、无阻塞 Operation，且存在有效 owner 或可以无恢复地原子 acquire 时，才直接创建 Run；否则入队。
- `enqueue`：在 Thread available 的前提下无条件创建 QueueItem。
- `requireImmediate`：不能立即执行则返回冲突，不创建 QueueItem。
- Queue 非空时普通 Submission 不得插队。
- Run 永远不使用排队状态。

### 7.2 Queue

- Queue 是 Thread 的持久 FIFO，不属于 RuntimeSession 或 Workspace。
- 用户 Stop 后 Queue 默认 `pausedByStop`，保留全部 QueueItem。
- Run `failed` 时，只有原 control state 为 active 才降为 `pausedByFailure`；不得覆盖 `pausedByUser | pausedByStop`。Run `completed` 不修改 control state。
- daemon 重启或 takeover 后，未完成 recovery 前不能自动消费 Queue。
- 修改 QueueItem 时创建新 InputItem，并 CAS 替换引用；InputItem 本身不可修改。

### 7.3 Steer

- `SteerStalePolicy = 'reject' | 'enqueue'`，默认 `enqueue`。
- Steer 不结束当前 Run。
- Steer 立即撤销旧 Plan Generation 对未来动作的授权。
- Server 停止模型流、冻结新工具调度、取消未开始工具、协作取消已开始工具、drain 并 reconcile。
- 已发生副作用进入 Ledger；被截断的 assistant 文本保留在 Transcript，但不原样进入模型 Context。
- Reconcile 成功后递增 `planGeneration`，在同一 `runId` 内继续。
- Steer 与 Stop 竞争时，Stop 优先。
- 已有 Steer 正在 quiesce/reconcile 时，新 Steer 只有在 target config/policy snapshot 相同且不存在更高优先级 control intent 时才能加入同一 coordination cycle；InputItem 按 accepted 顺序进入一个新 generation，generation 只递增一次。Snapshot 不同则返回 `OPERATION_CONFLICT`。
- Steer 接受前目标 Run 已非 active 时返回 `RUN_NOT_ACTIVE`，不创建 Operation。接受后、applied 前目标 Run 进入终态时，`reject` 使 Operation `cancelled`；`enqueue` 将尚未进入 Context 的 Steer InputItem 原子创建为 QueueItem，使 Operation `completed` 并返回 queueItemId。Fallback 必须排在现有 Queue 尾部，不得直接抢跑。

### 7.4 Stop

- Stop 先原子暂停 Queue，再将当前 Run 推进到 `stopping`。
- Stop 冻结调度、取消或 drain 工具并 reconcile。
- Run 最终进入 `stopped` 或因关键不确定性进入 `blocked`。
- Stop 不清空 Queue，不停止 Thread 或 daemon。
- Stop intent 必须持久化，owner 丢失后由新 owner继续完成。

## 8. Transcript 与 Model Context

UI 和模型上下文是两个投影：

- Transcript 保留用户已经看到的完整部分输出，并标记 `streaming | interrupted | completed` 和 finish reason。
- Context 只接收 committed Input、`completed` assistant message、Tool Fact、实际文件 revision、Approval/Policy Fact 和 compaction summary。
- 被 Steer 截断的自然语言、未完成 function-call JSON 和未确认异步结果不得进入 Context。
- assistant reasoning delta、streaming/interrupted message 和 draft checkpoint 永远不作为 assistant message 提交；若需要保留决策依据，只能转成结构化 summary/fact。
- Context 可以缓存，但必须可从 committed items 和 summaries 重建。
- 每次 Model Invocation 在开始时绑定不可变 `contextBoundaryId`；执行期间新增的 ContextItem 只能进入后续 invocation，不能改变正在流式生成的输入。

## 9. Execution Config 和 Policy Revision

Thread 维护单调 `executionConfigRevision`。Model/provider 默认值、非安全生成参数和下一 generation 的普通插件配置通过 Execution Config Change 更新。每个 Plan Generation 保存不可变 model config snapshot：

- 配置变更不修改当前 generation，也不使它 stale。
- 新配置默认从下一 Run 生效；当前 active Run 只有在显式 Steer/config replan 选中该 revision 时才切换。
- 用户要求当前 Run 立即使用新配置时，先提交 Config Change，再显式 Steer；Steer 在 accepted 时捕获目标 config revision，新 generation 使用该不可变 snapshot。之后到达的普通 Config Change 只影响更晚的 generation。
- Recovery、Policy Reconcile 和纯安全 replan 默认继承上一 generation 的 model config snapshot；只有 Initial Run、显式带 target config 的 Steer 或专门的 config replan 才采用新默认配置。
- Config Change 不得承载权限、trust、sandbox、network ceiling 或 credential revocation。

Thread 维护单调 `executionPolicyRevision`。每个 Plan Generation 保存创建时的不可变 effective policy snapshot；ToolExecution、Approval、Plugin invocation 和 Credential resolution 都绑定该 generation 及其 revision。revision 是策略身份，不得只依赖 Thread 当前配置反推旧计划权限。

- 能力放宽会创建新 revision，但当前 Plan Generation 继续受旧 snapshot 约束；新增能力仅对下一 Plan Generation 生效，不自动批准旧 Approval。
- 安全收紧创建 `policyReconcile` Operation：递增 policy revision、关闭调度、取消 scheduled tools、expire Approval、协作取消 running tools、reconcile，然后递增 Plan Generation 或阻塞 Run。
- Server 根据规范化 policy diff 判定放宽或收紧，客户端不得自行声明分类；mixed change 按安全收紧处理。
- 任一未知字段、插件自定义能力或无法证明单调放宽的 diff 都按安全收紧处理；分类器默认 deny，不能以“无法识别”为由走无 Operation 快路径。
- blocked trust、sandbox boundary 和 credential revocation 是不可由普通 mode/rule 放宽的 ceiling。

## 10. Workspace 和 Checkpoint

- 多个 Thread 可以绑定同一 Workspace，但各自拥有 Queue。
- Workspace mutation coordinator 按 canonical path 协调跨 Thread 写入。
- 单文件写使用 revision/hash 预条件、临时文件和 atomic rename。
- 多文件操作要么提供 journal/rollback，要么明确返回 partial result，不能伪装成原子操作。
- Checkpoint Apply 只允许在不存在 active Run、Checkpoint Apply、Steer/Stop reconciliation 或其他冲突性 workspace Operation 时开始；冲突时返回 `OPERATION_CONFLICT`，不得与当前工具写入并发。
- Checkpoint Apply 是持久 Operation；涉及工作区修改时创建 `kind=checkpointApply` 的特殊 Run 和对应 system InputItem，暂停 Queue，获取 mutation locks，并记录 Tool/Ledger/Reconciliation。
- Thread Fork 只复制选定 committed boundary 的 Context/Transcript summary、config/policy snapshot 和必要 Artifact reference；新 Queue 为空且 control state 为 active。它不复制源 Queue、RuntimeSession、active Run、pending Approval、Operation 或未终态工具。

## 11. 系统级不变量

| 编号         | 不变量                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| ARCH-INV-001 | 同一 Thread 任一时刻最多一个合法 lease holder。                               |
| ARCH-INV-002 | 同一 Thread 任一时刻最多一个非终态 active Run。                               |
| ARCH-INV-003 | QueueItem 消费与 Run 创建原子完成，一个 QueueItem 最多生成一个 Run。          |
| ARCH-INV-004 | Steer 保持 `runId`，Stop 终止 Run，下一 QueueItem 创建新 `runId`。            |
| ARCH-INV-005 | 旧 incarnation 或 generation 不得调度新动作或覆盖当前 Projection。            |
| ARCH-INV-006 | 已发生现实副作用不能被 Steer、Stop、Resume 或 Recovery 逻辑抹除。             |
| ARCH-INV-007 | Transcript 不是副作用事实来源，只有已验证 Ledger Fact 具有事实权威。          |
| ARCH-INV-008 | 长命令以及 model/tool/approval/workspace wait 必须有 Operation 和 crash branch。 |
| ARCH-INV-009 | 普通 Submission 不能绕过已有 Queue。                                          |
| ARCH-INV-010 | 安全策略收紧立即撤销未来调度权，但不伪造已发生副作用的回滚。                  |
| ARCH-INV-011 | Secret 不得进入 Thread、Ledger、Outbox、Snapshot 或日志。                     |
| ARCH-INV-012 | RuntimeSession 结束不改变 Thread 的持久存在性。                               |
| ARCH-INV-013 | Thread actor 属于 daemon control plane，RuntimeSession 是其可替换执行子资源。 |
| ARCH-INV-014 | 非 available Thread 不接受 Submission，也不自动消费 Queue。                   |
| ARCH-INV-015 | 当前 Plan Generation 始终按其不可变 policy snapshot 授权。                    |
| ARCH-INV-016 | Late Observation 可纠正 Tool outcome，但不得重新打开终态 Run。                |
| ARCH-INV-017 | Config Change 不得隐式修改当前 generation 的 model config snapshot。           |
| ARCH-INV-018 | Purge 必须由持久 RetentionJob 驱动，且不能删除仍被其他 Thread 引用的 artifact。 |

## 12. 2.0 非目标

- 不实现跨机器共享 SQLite。
- 不实现多 daemon control-plane active/active；同一数据目录只允许一个 daemon 持有进程生命周期锁。
- 不承诺恢复旧模型流、执行栈、PID、socket 或 transport。
- 不实现完全事件溯源。
- 不把 Voice 纳入第一版核心 Contract；Voice 作为客户端/扩展能力后续设计。
- 不在 2.0 同时交付 WinUI；Windows 客户端可以在稳定 Contract 上后续实现。
- 不把已知的认证、凭据泄漏、权限绕过、重复副作用或数据损坏风险推迟到 3.0；这些属于 2.0 发布门禁。3.0 聚焦性能、扩展性和进一步纵深防御。

## 13. 设计完成条件

- 四份规范之间术语、状态和 API 无冲突。
- 所有 `ARCH-INV-*` 都映射到实现测试。
- 状态机测试覆盖 Queue、Steer、Stop、Policy Reconcile 和 Recovery。
- Runtime 规范证明锁与等待关系无环。
- Contract 和 Persistence 规范定义 Snapshot barrier、Operation、Outbox 和事务边界。
