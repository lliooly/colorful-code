# Colorful Code 2.0 Implementation Roadmap

> **Status: Execution Roadmap**
>
> 本路线定义实现顺序和阶段门禁。具体编码前，可以再按阶段拆成更细的任务清单；不得跨过门禁同时铺开 CLI、SwiftUI 和未稳定的后端。

## 1. 规范输入

- [Core Architecture](../specs/2026-07-10-colorful-code-2-core-architecture-design.md)
- [Persistence Foundation](../specs/2026-07-10-colorful-code-2-persistence-foundation-design.md)
- [Thread Contract](../specs/2026-07-10-colorful-code-2-thread-contract-design.md)
- [Runtime Ownership and Recovery](../specs/2026-07-10-colorful-code-2-runtime-ownership-recovery-design.md)

历史讨论稿不是实现规范。

## 2. 发布原则

- 2.0 必须关闭已知认证绕过、凭据泄漏、权限 ceiling 绕过、重复副作用和数据损坏风险。
- 2.x 用于修复新发现问题、增强平台能力和逐步推进 Windows 客户端。
- 3.0 聚焦高性能、远程 sandbox、多 worker、可观测性和产品完整度，不能作为推迟已知安全漏洞的理由。
- 每个 Phase 通过自己的测试门禁后再进入下一阶段。

## 3. Phase -1：安全冻结与基线

目标：停止扩大旧 UI 功能面，并确保 2.0 开发期间现有版本不会继续积累高风险债务。

工作：

- 冻结 Web/Tauri 体验功能，只接受稳定性和安全修复。
- 固化当前数据库、SessionSnapshot、API 和测试 fixture。
- 为已复现竞态保留 barrier/deferred Promise 失败测试。
- 立即修复仍会暴露给用户的凭据外泄、preset endpoint override、blocked trust 绕过和明显数据损坏问题。
- 建立 2.0 feature flag 或独立模块边界，避免旧 SessionStore 与新 ThreadStore 长期双写。

门禁：

- 当前主干测试基线稳定。
- 旧数据库 fixture 可重复创建。
- 已知 Critical 安全问题有修复或明确禁用路径。

## 4. Phase 0A：Persistence Kernel

严格按以下顺序：

```text
Data-directory Instance Lock
-> Migration Bootstrap Connection + Migration Framework
-> DatabaseProvider
-> Transaction API
-> Database Clock
-> SQLite configuration
-> Test Database Factory
-> 1.x Schema Baseline
```

关键要求：

- Instance lock 必须在打开业务数据库前获取，并持有到 daemon 退出；Migration lock 遵循同一锁顺序。
- Migration Framework 只使用最窄的 bootstrap SQLite connection，不提前暴露业务 repository。
- 用 forward-only migration 替代散落 DDL。
- 使用 SQLite Online Backup API 或一致性 `VACUUM INTO`。
- Transaction callback 同步、纯数据库、无外部 await/side effect。
- 统一 WAL、foreign keys、busy timeout、synchronous 和 retry policy。

门禁：

- 第二个 daemon 无法在同一 data directory 上打开业务数据库。
- 空数据库、当前生产数据库、重复启动和损坏 migration fixture 全部通过。
- migration 失败能关闭数据库并恢复一致性备份。
- `SQLITE_BUSY` 测试不会重复业务副作用。

## 5. Phase 0B：Contract Foundation

实现 `packages/schema` 的公共 authoring source：

```text
common / ids / enums
thread / run / queue / operation
commands / ack / errors
events / snapshot / auth / config / policy
```

随后生成：

- OpenAPI v2。
- Event JSON Schema。
- TypeScript validators/types。
- Swift Codable fixture。

此阶段只实现 schema、生成器和 conformance test，不急着写 Controller。

门禁：

- Generated artifacts 无 diff。
- TypeScript/Swift golden fixture 覆盖 enum、optional、nullable、union、unknown event 和 64-bit cursor。
- 正式 schema 中不存在禁用旧术语。

## 6. Phase 0C：Recovery Primitives

先创建最小但完整的事务基础表：

```text
threads
input_items
operations
command_deduplication
ledger_events
event_outbox
```

实现统一 Transaction Writer：

```text
appendLedger
appendOutbox
create/updateOperation
saveCommandAck
allocateThreadSequences
```

门禁：

- Projection + Ledger + Outbox crash-before/after 测试全部通过。
- 相同 commandId/hash 返回原 Ack；不同 hash 返回冲突。
- 非终态 Operation 可以在进程重启后直接查询。

## 7. Phase 0D：Thread Actor 与 EventMux

先使用 fake executor 和 test repository 实现：

- ThreadActor registry 和 deterministic mailbox。
- 优先级：Lease Lost、Stop、Policy Tighten、Steer、Observation、Normal、Maintenance。
- EventMux、durable Outbox drain 和 transient ring buffer。
- connection barrier、dual cursor、durableBasis、streamBasis 和 Snapshot Reset。
- Actor/connection buffer timeout 和 backpressure policy。

门禁：

- Actor 在模型、工具、Approval 和 lock 等待期间仍能处理 Stop/Lease Lost。
- Snapshot barrier 每个阶段注入事件后无重复、无遗漏。
- assistant/tool terminal event 不会越过它因果依赖的最后一个 transient delta。
- 网络慢客户端不能阻塞 actor或其他 subscriber。

## 8. Phase 0E：Ownership Foundation

实现：

```text
worker_registry
thread_leases
runtime_incarnations (diagnostic only)
late_observation_inbox
lease acquire/CAS
heartbeat
local fencing
takeover
graceful drain
```

先实现 single daemon + local workers；remote worker 只保留内部接口，不在此阶段建设远程平台。

门禁：

- 双 worker acquire 只有一个成功。
- 过期 Lease 不能续命；takeover 单赢家。
- daemon 存活但 owner worker 崩溃时停止续租，不会制造永久假活 Lease。
- 旧 owner的 Projection/Approval/Queue/Tool 写入全部被 fence。
- 旧 owner的事实只能进入 Inbox。
- macOS sleep/wake 和 daemon crash fixture 通过。

## 9. Phase 1：Domain Projections

按依赖创建：

```text
runs + plan_generations
-> queue_items
-> tool_executions + attempts
-> approvals
-> transcript_items + transcript_drafts + context_items + context_boundaries
-> artifacts + artifact_references + checkpoints
-> credential_refs metadata
-> retention_jobs
```

同时加入数据库 CHECK、foreign key、partial unique index 和查询 index。
`threads` 必须包含独立单调 `queue_revision`、`execution_config_revision` 和 `execution_policy_revision`，并把 Queue control state 与 indeterminate blocker 分列保存；每个 Plan Generation 必须保存不可变 model config/effective policy snapshot。

门禁：

- 一个 Thread 最多一个非终态 Run。
- Queue consume 与 Run create 原子完成。
- Blocked Run 保留 activeRunId。
- Input、Ledger、Transcript/Context 边界符合规范。

## 10. Phase 2：Command State Machines

按风险从低到高实现：

1. Thread create/read/patch、archive/unarchive/undelete/fork。
2. Submission `auto/enqueue/requireImmediate` 和 Queue control。
3. Run start/completion 和 model loop 适配。
4. Approval。
5. Stop。
6. Steer。
7. Compaction。
8. Checkpoint Apply。
9. Execution Config Change、Policy Change 和 Policy Reconcile。
10. RetentionJob 和幂等 Purge。

每个异步命令先写 accepted Operation，再由 actor推进 phase。不要把整个命令实现成一个长 Promise。
每次模型请求和工具动作分别创建 system `modelInvocation` / `toolInvocation` Operation；Approval、Workspace wait、stream 和 tool completion 不保留为不可恢复 Promise。
本阶段只接 fake executor 或 Phase 3 定义的安全 adapter；在 Dispatch Permit、Workspace Coordinator 和 Observation 闭环通过门禁前，不启用真实副作用。

门禁：

- Stop > Steer 优先级成立。
- Stop、Steer 和 Policy Reconcile 竞争时只有一个物理 drain/reconcile cycle，各 Operation 仍有独立终态。
- Submission 不可绕过已有 Queue。
- Run failed 默认把 active Queue control state 降为 pausedByFailure；completed 不改变 Queue control。
- 所有 Operation 有 completed/failed/cancelled/blocked 和 crash branch。
- Policy tighten 能 fence active generation。
- Policy relax 不会让当前 generation 获得 snapshot 之外的新权限。
- Config change 不改变当前 generation；显式 Steer 后的新 generation 使用最新 config。
- Checkpoint Apply 无法与 active Run 或冲突性 workspace Operation 并发。
- Archive/Delete 会先 drain/release idle Lease，不会留下非 available Thread 的活 runtime。
- Purge crash 后可按 RetentionJob phase 续跑，且不会删除 shared artifact。

## 11. Phase 3：Tool Runtime Safety

实现：

- Workspace Coordinator 和 canonical multi-path lock order。
- 绑定 worker/attempt 的 signed Dispatch Permit、anti-replay、timeout 和 cancellation。
- ToolExecution/Attempt/idempotency key。
- Intent -> Side Effect -> Observation。
- 文件 revision/hash、atomic rename 和 partial result。
- MCP/LSP/model structured concurrency、single-flight、timeout 和 drain。
- 外部系统 reconciliation adapter 和 indeterminate 状态。

门禁：

- 不存在持 SQLite transaction 等待外部 IO 的路径。
- 反向多路径 lock 测试不死锁。
- Side effect 完成但 Observation 丢失时可 recovery。
- 不支持幂等/reconcile 的高风险工具不会自动重试。

## 12. Phase 4：Public v2 Server

实现：

- REST Controller/handler 绑定 Zod Contract。
- SSE attach/replay/reset。
- Command Ack、ApiError 和 Operation query。
- daemon discovery 连接 Phase 0A 已建立的 singleton instance、本地认证，以及 Rust Credential Broker 的 write/resolve/revoke IPC；REST 不接触 secret。
- TypeScript client 和统一 reducer。

门禁：

- OpenAPI conformance 全通过。
- Auth、Origin、token rotation 和 redaction 测试通过。
- SSE 断线、cursor expiry、incarnation change 和慢客户端测试通过。

## 13. Phase 5：Crash Recovery 与故障注入

完善：

- Takeover Recovery Coordinator。
- Operation resume/stop/fail/block 决策。
- Workspace drift detection。
- Late Observation adjudication。
- Post-terminal Tool correction 和 `lateObservationReconcile` Operation。
- Outbox publisher restart/duplicate。
- Process crash、database busy、worker loss、tool uncertainty fixtures。

门禁：

- Recovery decision 都携带 reason/evidence。
- 关键 indeterminate 不会自动继续 Queue。
- Late Observation 可以修正 Tool outcome，但不能重新打开 terminal Run。
- Projection、Ledger、Operation、Outbox 在注入点前后保持一致。
- 状态机和死锁检测未发现已知阻塞缺陷。

## 14. Phase 6：Legacy Migration 和 Compatibility

实现：

- 旧历史快照 importer 和 legacy alias。
- synthetic imported Run。
- audit/checkpoint 引用迁移。
- quarantine、source hash 和完整性校验。
- 独立 compatibility adapter 和 sunset headers。

门禁：

- 真实旧数据库副本迁移成功。
- 迁移失败可恢复备份。
- Adapter 不引入第二套持久状态或长期双写。

## 15. Phase 7：Ink CLI

CLI 是第一个标准客户端，必须先于 SwiftUI 达标：

- Thread/Run/Queue/Operation 完整交互。
- Queue/Steer/Stop。
- Approval、模型和插件配置。
- 通过共享 Rust Credential Broker 写入/撤销 secret，REST 只提交 credentialRef。
- SSE reducer、Snapshot Reset 和断线恢复。
- `doctor`、JSON output 和可脚本化 exit code。

CLI 发布门禁场景：

- create -> submit -> tool -> approval -> complete。
- Queue、Steer、Stop 和重复 command。
- 断线、duplicate event、Snapshot Reset。
- daemon restart、Run recovery、Policy Reconcile。
- 任一错误路径都 abort/drain 并返回稳定 exit code。

## 16. Phase 8：SwiftUI macOS Client

只使用生成 Codable models 和 ThreadEventStore actor：

- Thread/Project navigation。
- Transcript、Tool、Approval、Queue 和 Operation UI。
- Queue/Steer 默认偏好。
- 与 Ink/daemon 共用的 Rust Credential Broker、目录选择和系统权限。
- daemon lifecycle、discovery、更新和诊断。

SwiftUI 不复制后端状态机，ViewModel 只消费 reducer/actor projection。

门禁：

- CLI 与 SwiftUI 使用相同 contract fixtures 得到相同 Thread state。
- App 重启、daemon 重启、系统休眠和网络/IPC 断开后正确恢复。
- 无 API key、token 或敏感 tool payload 泄漏。

## 17. Phase 9：2.0 Release Engineering

- macOS code signing 和 notarization。
- Signed updater 和 stable/beta/nightly channels。
- Sidecar artifact checksum 和 provenance。
- Reproducible package pipeline。
- Migration backup/rollback 演练。
- 安全、并发、故障注入和端到端发布矩阵。

2.0 发布条件：所有已知 P0/P1 安全与数据一致性问题关闭；CLI 和 SwiftUI golden path 通过；签名、公证、升级和旧数据迁移经过真实产物验证。

## 18. 2.x 到 3.0

2.x：

- 修复新发现的安全与正确性问题。
- 优化 UX、工具兼容性、插件生态和 Windows client。
- 在不改变核心 Contract 的前提下补可观测性。

3.0：

- Remote sandbox 和受控 worker pool。
- 更高并发的 Scheduler 和 workspace coordination。
- Ledger/Outbox compaction、分层存储和性能优化。
- 大型仓库增量索引、上下文检索和企业策略。

任何新发现的可利用漏洞都应立即修复，不等待大版本。

## 19. 每阶段工作方式

1. 先写失败测试，精确控制时序，不用延长 timeout 代替 barrier。
2. 每次只实现一个事务或状态转换。
3. 每个 commit 保持 migration、schema、实现和测试一致。
4. 不在同一阶段并行重写旧 UI。
5. 每通过一个 Phase，更新 verification matrix 和 architecture decision 状态。
