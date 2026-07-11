# Colorful Code 2.0 Persistence Foundation

> **Status: Normative**
>
> 本文档定义 Colorful Code 2.0 的 SQLite 基础设施、迁移、Schema、Transaction Matrix、Ledger、Outbox、Operations 和 1.x 数据导入。

## 1. 依赖与范围

本文实现并验证 [Core Architecture](./2026-07-10-colorful-code-2-core-architecture-design.md) 中的数据权威关系和系统不变量。

目标：

- 建立单例 DatabaseProvider 和统一事务 API。
- 用 forward-only migration 替代启动时散落的幂等 DDL。
- 让 Projection、Ledger、Operation、Command Deduplication 和 Event Outbox 共享事务边界。
- 为 Lease、Crash Recovery 和客户端事件续传提供可靠存储。
- 安全导入现有整块历史快照，不伪造旧运行时状态。

非目标：

- 不实现多节点共享 SQLite。
- 不实现通用分布式事务。
- 不实现 down migration。
- 不把所有 transient delta 写入数据库。

## 2. DatabaseProvider

SQLite 驱动可以是同步的，但应用接口返回 Promise，便于调用方统一处理。事务 callback 必须同步且只操作数据库，类型上禁止返回 Promise。

```ts
export interface DatabaseProvider {
  readonly dialect: 'sqlite';

  read<T>(operation: (db: ReadDatabase) => T): Promise<T>;

  write<T>(
    operation: (tx: WriteTransaction) => T,
    options?: { retryMode?: 'safe' | 'none' },
  ): Promise<T>;

  close(): Promise<void>;
}
```

`ReadDatabase` 和 `WriteTransaction` 不暴露网络、文件系统、进程或工具 API。

### 2.1 Callback 规则

允许：

- SQL 读取和写入。
- 数据库时钟。
- 纯内存序列化、hash 和 schema validation。
- Projection、Ledger、Operation、Deduplication 和 Outbox 更新。

禁止：

- `fetch`、MCP、LSP、模型调用。
- 文件系统、进程、sleep、Approval 或 tool execution。
- 获取 workspace lock 或等待 Thread actor。
- 任意外部 `await`。

### 2.2 Retry

- 默认 `retryMode` 为 `none`；只有调用方显式选择 `safe` 才能重放 callback。
- 只重试 `SQLITE_BUSY` / `SQLITE_LOCKED` 等明确可恢复竞争。
- `retryMode: safe` 要求 callback 无外部副作用、业务 ID 在事务外生成、写入受幂等约束保护。
- Provider 不得重试已经执行过外部副作用的业务函数。
- Tool Observation 只能重试最后的纯数据库事务。
- Retry 使用有上限的 exponential backoff + jitter，并输出结构化指标。

## 3. SQLite 配置

每个数据库连接统一执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

- `busy_timeout` 必须小于 Lease TTL 的安全余量。
- 所有写事务保持短小；不得因为业务等待占住 writer lock。
- `synchronous` 是否降为 `NORMAL` 只能在故障测试和性能基准后通过独立决策修改。

## 4. 统一数据库时钟

Ownership 和持久状态使用数据库时钟，不使用 worker wall clock 决定 Lease 有效性。

```ts
export interface DatabaseClock {
  nowEpochMs(tx: ReadDatabase): number;
}
```

测试数据库注入可控 Clock，用于 Lease、Retention 和 Recovery 时序测试。

## 5. Migration Framework

### 5.1 Migration Table

```text
schema_migrations
  version INTEGER PRIMARY KEY
  name TEXT NOT NULL
  checksum TEXT NOT NULL
  applied_at INTEGER NOT NULL
  duration_ms INTEGER NOT NULL
```

- Migration 文件有不可变 version、name 和 checksum。
- 已应用 migration 的 checksum 变化时启动失败。
- Migration 只向前执行。

### 5.2 Startup 流程

```text
acquire interprocess migration lock
stop business writes
create consistent backup
run pending migrations in order
run foreign_key_check
run integrity_check
record schema version
release migration lock
start server
```

- 迁移期间 API 不进入 ready 状态。
- Migration lock 必须使用当前用户专属的 OS file lock 或等价 interprocess primitive；普通内存 mutex 不足以协调多个 daemon。
- 多个 daemon 进程同时启动时只有一个可以迁移，其余进程保持 not-ready 并等待或退出。
- Backup 使用 SQLite Online Backup API；不可用时使用一致性 `VACUUM INTO` 流程。
- 禁止直接复制 WAL 模式下仍在写入的主数据库文件。
- 迁移失败时关闭数据库，原子恢复备份，再以 migration failure 状态退出。

### 5.3 1.x Baseline

第一条 migration 只记录当前生产 Schema baseline，不改变数据。后续 migration 创建 2.0 表和 importer marker，使测试、全新安装和旧数据库升级使用同一链路。

## 6. Schema 分层

### 6.1 Recovery Primitives

这些表必须先于 Lease 和 Domain command 实现：

| 表                      | 责任                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `threads`               | 最小 Thread identity、lifecycle、revision、policy revision、lease epoch counter。 |
| `input_items`           | 不可变输入。                                                                      |
| `operations`            | 长命令当前状态和 recovery 入口。                                                  |
| `command_deduplication` | command identity、payload hash、原始 Ack。                                        |
| `ledger_events`         | 不可变语义事实。                                                                  |
| `event_outbox`          | Durable client event 和 replay cursor。                                           |

### 6.2 Ownership Tables

| 表                       | 责任                                           |
| ------------------------ | ---------------------------------------------- |
| `worker_registry`        | Worker 能力和辅助 liveness，不代表 ownership。 |
| `thread_leases`          | 当前 Thread owner。                            |
| `runtime_incarnations`   | 可选诊断记录，不是 ownership 权威。            |
| `late_observation_inbox` | 非当前 owner 的迟到事实。                      |

### 6.3 Domain Projections

| 表                        | 责任                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `queue_items`             | Thread FIFO 和 dispatch 状态。                             |
| `runs`                    | Run 当前状态和 terminal summary。                          |
| `plan_generations`        | 每代输入、policy/model snapshot、context boundary 和终态。 |
| `tool_executions`         | 逻辑工具动作。                                             |
| `tool_execution_attempts` | 具体执行尝试。                                             |
| `approvals`               | Approval 当前状态。                                        |
| `transcript_items`        | 用户可见追加记录。                                         |
| `transcript_drafts`       | 当前 assistant 聚合草稿的低频 crash checkpoint。           |
| `context_items`           | 模型可见 committed context。                               |
| `context_boundaries`      | 不可变 Context 装配边界和 compaction lineage。              |
| `artifacts`               | 可共享的文件、diff、日志和外部存储对象。                   |
| `artifact_references`     | Thread/Run/Checkpoint 对 Artifact 的正规化引用。           |
| `checkpoints`             | 显式恢复点和 artifact references。                         |
| `credential_refs`         | 系统凭据存储中的非敏感引用元数据，不保存 secret。          |

### 6.4 Control-plane Jobs

| 表               | 责任                                                       |
| ---------------- | ---------------------------------------------------------- |
| `retention_jobs` | 独立持久 purge phase；不级联依赖 Thread，删除后仍保留审计。 |

## 7. 核心字段

### 7.1 Threads

```text
thread_id TEXT PRIMARY KEY
lineage_id TEXT NOT NULL
parent_thread_id TEXT NULL
lifecycle TEXT NOT NULL
title TEXT NULL
workspace_binding_json TEXT NOT NULL
default_config_json TEXT NOT NULL
execution_policy_json TEXT NOT NULL
queue_control_state TEXT NOT NULL
queue_blocked_by_indeterminate INTEGER NOT NULL
queue_revision INTEGER NOT NULL
active_run_id TEXT NULL
revision INTEGER NOT NULL
execution_config_revision INTEGER NOT NULL
execution_policy_revision INTEGER NOT NULL
lease_epoch_counter INTEGER NOT NULL
next_ledger_sequence INTEGER NOT NULL
next_event_sequence INTEGER NOT NULL
current_checkpoint_id TEXT NULL
deleted_at INTEGER NULL
purge_after INTEGER NULL
purge_started_at INTEGER NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

Thread default config 和 execution policy 中的模型、插件凭据只保存 `credentialRef`。
`ThreadRuntimeStatus` 由 Lease、active Run、Operation 和 RuntimeSession 派生，不在 `threads` 中保存第二份权威状态。

### 7.2 Input Items

```text
input_item_id TEXT PRIMARY KEY
thread_id TEXT NOT NULL
role TEXT NOT NULL
source TEXT NOT NULL
content_json TEXT NOT NULL
supersedes_input_item_id TEXT NULL
created_by TEXT NOT NULL
created_at INTEGER NOT NULL
```

InputItem 创建后禁止 UPDATE；编辑通过新建记录并更新引用实现。

### 7.3 Operations

```text
operation_id TEXT PRIMARY KEY
client_identity TEXT NOT NULL
command_id TEXT NOT NULL
thread_id TEXT NOT NULL
run_id TEXT NULL
parent_operation_id TEXT NULL
input_context_boundary_id TEXT NULL
kind TEXT NOT NULL
status TEXT NOT NULL
phase TEXT NOT NULL
coordination_cycle_id TEXT NULL
accepted_ledger_sequence INTEGER NOT NULL
payload_hash TEXT NOT NULL
input_item_id TEXT NULL
expected_plan_generation INTEGER NULL
applied_plan_generation INTEGER NULL
created_config_revision INTEGER NOT NULL
target_config_revision INTEGER NULL
target_config_snapshot_json TEXT NULL
applied_config_revision INTEGER NULL
created_policy_revision INTEGER NOT NULL
target_policy_revision INTEGER NULL
target_policy_snapshot_json TEXT NULL
applied_policy_revision INTEGER NULL
result_json TEXT NULL
error_code TEXT NULL
revision INTEGER NOT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
terminal_at INTEGER NULL
UNIQUE(client_identity, command_id)
UNIQUE(thread_id, accepted_ledger_sequence)
```

非终态 Operation 查询不得依赖 Ledger replay。
自动 Compaction、Recovery 等内部 Operation 使用保留的 system client identity 和 Server 生成的 commandId；不得使用 nullable identity 绕过幂等与审计链。
Operation snapshot 只能保存非敏感 config/policy 和 `credentialRef`。target revision 与 target snapshot 必须同时为空或同时存在；Steer、Policy Reconcile 等延迟应用命令不能在恢复时回读 Thread 当前值替代 accepted snapshot。
`parent_operation_id` 构成同 Thread 的无环 operation tree，用于把 model/tool invocation 关联到 Steer、Stop、Checkpoint Apply 或 Recovery；取消沿树向下传播，子 Operation terminal 不反向重开已终态父 Operation。

### 7.4 Command Deduplication

```text
client_identity TEXT NOT NULL
command_id TEXT NOT NULL
payload_hash TEXT NOT NULL
operation_id TEXT NULL
ack_json TEXT NOT NULL
created_at INTEGER NOT NULL
PRIMARY KEY (client_identity, command_id)
```

- 相同 key + 相同 hash 返回原 Ack。
- 相同 key + 不同 hash 返回 `COMMAND_ID_CONFLICT`。
- `payload_hash` 由 Server 对已通过 Schema 校验的 command kind、route identity、path parameters 和移除 `commandId` 后的 body 做 canonical JSON 编码，再计算 SHA-256；不得信任客户端提交的 hash，也不得对原始 JSON 字节直接 hash。

### 7.5 Ledger Events

```text
ledger_event_id TEXT PRIMARY KEY
transition_id TEXT NOT NULL
thread_id TEXT NOT NULL
ledger_sequence INTEGER NOT NULL
event_type TEXT NOT NULL
payload_version INTEGER NOT NULL
payload_json TEXT NOT NULL
occurred_at INTEGER NOT NULL
UNIQUE(thread_id, ledger_sequence)
```

### 7.6 Event Outbox

```text
event_id TEXT PRIMARY KEY
transition_id TEXT NOT NULL
thread_id TEXT NOT NULL
event_sequence INTEGER NOT NULL
kind TEXT NOT NULL
payload_version INTEGER NOT NULL
payload_json TEXT NOT NULL
stream_basis_incarnation_id TEXT NULL
stream_basis_sequence INTEGER NULL
created_at INTEGER NOT NULL
published_at INTEGER NULL
publish_attempts INTEGER NOT NULL
last_publish_error TEXT NULL
UNIQUE(thread_id, event_sequence)
```

Published row 在 replay retention watermark 前不得删除。
两个 stream basis 字段必须同时为 NULL 或同时非 NULL。它们只记录 durable event 的跨流因果前置，不进入 durable sequence 分配。

### 7.7 Queue Items

```text
queue_item_id TEXT PRIMARY KEY
thread_id TEXT NOT NULL
input_item_id TEXT NOT NULL
position TEXT NOT NULL
revision INTEGER NOT NULL
status TEXT NOT NULL
source_run_id TEXT NULL
resulting_run_id TEXT NULL UNIQUE
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(thread_id, position)
```

QueueItem 只有 `queued | consumed | removed`。
`position` 是 Server 生成的 opaque sortable key；客户端只提交 before/after identity。Reorder 使用 Queue revision CAS，必要时由单个事务重新编号，客户端不得自行计算 position。

### 7.8 Runs

```text
run_id TEXT PRIMARY KEY
thread_id TEXT NOT NULL
kind TEXT NOT NULL
source_input_item_id TEXT NOT NULL
source_queue_item_id TEXT NULL UNIQUE
status TEXT NOT NULL
plan_generation INTEGER NOT NULL
execution_config_revision INTEGER NOT NULL
execution_policy_revision INTEGER NOT NULL
terminal_reason_json TEXT NULL
created_at INTEGER NOT NULL
started_at INTEGER NULL
ended_at INTEGER NULL
revision INTEGER NOT NULL
```

使用 partial unique index 保证每个 Thread 最多一个非终态 active Run。

```sql
CREATE UNIQUE INDEX one_active_run_per_thread
ON runs(thread_id)
WHERE status NOT IN ('completed', 'failed', 'stopped');
```

### 7.9 Tool Execution 和 Attempt

```text
tool_executions
  tool_execution_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  run_id TEXT NOT NULL
  operation_id TEXT NOT NULL
  plan_generation INTEGER NOT NULL
  execution_policy_revision INTEGER NOT NULL
  owner_incarnation_id TEXT NOT NULL
  owner_lease_epoch INTEGER NOT NULL
  tool_name TEXT NOT NULL
  tool_descriptor_hash TEXT NOT NULL
  arguments_json TEXT NOT NULL
  arguments_hash TEXT NOT NULL
  idempotency_key TEXT NOT NULL UNIQUE
  state TEXT NOT NULL
  reconciliation_key TEXT NULL
  result_json TEXT NULL
  revision INTEGER NOT NULL
  reconciled_at INTEGER NULL
  started_at INTEGER NULL
  ended_at INTEGER NULL

tool_execution_attempts
  attempt_id TEXT PRIMARY KEY
  tool_execution_id TEXT NOT NULL
  runtime_incarnation_id TEXT NOT NULL
  permit_id TEXT NOT NULL UNIQUE
  transport_request_id TEXT NULL
  outcome TEXT NULL
  started_at INTEGER NOT NULL
  ended_at INTEGER NULL
```

`arguments_json` 是通过对应版本 Tool schema 校验后的 canonical、secret-free payload；凭据只允许使用 `credentialRef`，hash 从该 canonical payload 计算。`result_json` 只保存有界、redacted summary；完整 stdout、diff 或大结果写 Artifact 并建立 reference。Descriptor hash 固定该执行的副作用分类、幂等与 reconciliation capability，Recovery 不得用当前插件描述覆盖历史 descriptor。

### 7.10 Late Observation Inbox

```text
observation_id TEXT PRIMARY KEY
dedup_key TEXT NOT NULL UNIQUE
thread_id TEXT NOT NULL
run_id TEXT NOT NULL
tool_execution_id TEXT NULL
attempt_id TEXT NULL
source_worker_id TEXT NOT NULL
source_incarnation_id TEXT NOT NULL
source_lease_epoch INTEGER NOT NULL
source_plan_generation INTEGER NOT NULL
kind TEXT NOT NULL
payload_version INTEGER NOT NULL
payload_json TEXT NOT NULL
payload_hash TEXT NOT NULL
status TEXT NOT NULL
resolution_reason TEXT NULL
resolved_at INTEGER NULL
resolved_by_incarnation_id TEXT NULL
received_at INTEGER NOT NULL
```

### 7.11 Plan Generations

```text
plan_generation_id TEXT PRIMARY KEY
thread_id TEXT NOT NULL
run_id TEXT NOT NULL
generation INTEGER NOT NULL
cause TEXT NOT NULL
source_operation_id TEXT NULL
input_item_id TEXT NULL
execution_config_revision INTEGER NOT NULL
execution_policy_revision INTEGER NOT NULL
effective_policy_snapshot_json TEXT NOT NULL
model_config_snapshot_json TEXT NOT NULL
tool_schema_set_hash TEXT NOT NULL
tool_schema_set_artifact_id TEXT NOT NULL
current_context_boundary_id TEXT NOT NULL
reconciliation_summary_json TEXT NULL
created_at INTEGER NOT NULL
terminal_at INTEGER NULL
terminal_reason_json TEXT NULL
UNIQUE(run_id, generation)
```

`cause` 仅允许 initial、steer、recovery、policyReconcile 或 explicitReplan。Effective policy 和 Model config snapshot 只保存非敏感配置和 `credentialRef`，共同定义该 generation 的不可变执行授权。Tool schema/descriptor set 以 immutable Artifact 保存，hash 与 artifact content hash 一致，使插件升级/删除后仍能审计和 reconcile 历史执行。

### 7.12 Approvals

```text
approval_id TEXT PRIMARY KEY
thread_id TEXT NOT NULL
run_id TEXT NOT NULL
tool_execution_id TEXT NULL
operation_id TEXT NULL
plan_generation INTEGER NOT NULL
execution_policy_revision INTEGER NOT NULL
owner_lease_epoch INTEGER NOT NULL
status TEXT NOT NULL
request_json TEXT NOT NULL
decision_json TEXT NULL
revision INTEGER NOT NULL
requested_at INTEGER NOT NULL
resolved_at INTEGER NULL
expires_at INTEGER NULL
```

Approval status 仅允许 pending、approved、rejected、expired 或 cancelled。Decision 使用 revision CAS；generation、安全收紧 policy 或 owner 改变后不得复用旧 Approval。纯放宽不改变该 Approval 绑定的旧 policy snapshot。

### 7.13 Transcript 和 Context

```text
transcript_items
  transcript_item_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  run_id TEXT NULL
  input_item_id TEXT NULL
  ordinal INTEGER NOT NULL
  role TEXT NOT NULL
  content_json TEXT NOT NULL
  status TEXT NOT NULL
  finish_reason TEXT NULL
  created_at INTEGER NOT NULL
  UNIQUE(thread_id, ordinal)

transcript_drafts
  assistant_message_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  run_id TEXT NOT NULL
  plan_generation INTEGER NOT NULL
  incarnation_id TEXT NOT NULL
  accumulated_content_json TEXT NOT NULL
  last_stream_sequence INTEGER NOT NULL
  updated_at INTEGER NOT NULL
  UNIQUE(run_id, assistant_message_id)

context_items
  context_item_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  run_id TEXT NULL
  plan_generation INTEGER NULL
  source_kind TEXT NOT NULL
  source_id TEXT NOT NULL
  ordinal INTEGER NOT NULL
  content_json TEXT NOT NULL
  payload_hash TEXT NOT NULL
  created_at INTEGER NOT NULL
  UNIQUE(thread_id, ordinal)
  UNIQUE(thread_id, source_kind, source_id)

context_boundaries
  context_boundary_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  run_id TEXT NULL
  plan_generation INTEGER NULL
  parent_boundary_id TEXT NULL
  compacted_through_ordinal INTEGER NOT NULL
  visible_through_ordinal INTEGER NOT NULL
  summary_context_item_id TEXT NULL
  cause TEXT NOT NULL
  source_operation_id TEXT NULL
  created_at INTEGER NOT NULL
```

Transient delta 不逐条写 Transcript。EventMux 按 byte/time threshold 将当前聚合文本 coalesce 更新到 `transcript_drafts`，不为每个 token 写 Ledger/Outbox。assistant 输出在 completed、steered 或 stopped 时从内存聚合成 append-only TranscriptItem 并删除 draft；Steer/Stop 的 barrier 必须先捕获完整当前 buffer。

daemon crash 后只使用最后持久 draft：Recovery 将其转换为 `status=interrupted`、`finishReason=daemonLost` 的 TranscriptItem，并明确 lastStreamSequence；checkpoint 后尚未落盘的 token 允许丢失，系统不得根据客户端缓存或最终文本伪造。只有 `completed` assistant message 可以生成 ContextItem；被截断/崩溃自然语言、reasoning delta 和 draft 不得生成 ContextItem。

ContextBoundary 行创建后不可修改。`compacted_through_ordinal` 表示已被 summary 替代的前缀终点，`visible_through_ordinal` 表示该边界可见的最新 committed item；Assembler 使用 `summary_context_item_id`（若有）加 `(compactedThrough, visibleThrough]` 中非 compaction-summary 的原始 items，避免 summary 重复注入。每次 committed Context 批次或 Compaction 都新建 boundary 并原子更新 Plan Generation 的 current pointer。Model invocation Operation 在开始时保存 `input_context_boundary_id`，不能在响应途中漂移到新边界。

### 7.14 Artifacts 和 Checkpoints

```text
artifacts
  artifact_id TEXT PRIMARY KEY
  kind TEXT NOT NULL
  storage_ref TEXT NOT NULL UNIQUE
  content_hash TEXT NOT NULL
  metadata_json TEXT NOT NULL
  created_at INTEGER NOT NULL

artifact_references
  artifact_reference_id TEXT PRIMARY KEY
  artifact_id TEXT NOT NULL
  thread_id TEXT NOT NULL
  scope_kind TEXT NOT NULL
  scope_id TEXT NOT NULL
  purpose TEXT NOT NULL
  created_at INTEGER NOT NULL
  UNIQUE(artifact_id, scope_kind, scope_id, purpose)

checkpoints
  checkpoint_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  run_id TEXT NULL
  parent_checkpoint_id TEXT NULL
  logical_boundary_json TEXT NOT NULL
  workspace_fingerprint_json TEXT NOT NULL
  schema_version INTEGER NOT NULL
  created_at INTEGER NOT NULL
```

`scope_kind` 仅允许 thread、run 或 checkpoint；`scope_id` 必须在事务中验证属于同一个 thread_id。Checkpoint 是逻辑边界，并通过 `artifact_references` 关联 artifact，不暗示工作区已自动回退。Apply 通过持久 Operation 和特殊 Run 执行。Fork 为边界内仍需保留的对象创建新 Thread scope reference，不复制 storage object，也不让新 Thread reference 指向源 Thread 的 Run/Checkpoint identity。

### 7.15 Worker、Lease 和 Runtime Diagnosis

```text
worker_registry
  worker_id TEXT PRIMARY KEY
  daemon_instance_id TEXT NOT NULL
  capabilities_json TEXT NOT NULL
  started_at INTEGER NOT NULL
  heartbeat_at INTEGER NOT NULL
  expires_at INTEGER NOT NULL

thread_leases
  thread_id TEXT PRIMARY KEY
  worker_id TEXT NOT NULL
  incarnation_id TEXT NOT NULL UNIQUE
  lease_epoch INTEGER NOT NULL
  state TEXT NOT NULL
  acquired_at INTEGER NOT NULL
  heartbeat_at INTEGER NOT NULL
  expires_at INTEGER NOT NULL
  drain_deadline INTEGER NULL

runtime_incarnations
  incarnation_id TEXT PRIMARY KEY
  thread_id TEXT NOT NULL
  worker_id TEXT NOT NULL
  lease_epoch INTEGER NOT NULL
  opened_at INTEGER NOT NULL
  closed_at INTEGER NULL
  close_reason TEXT NULL
```

`runtime_incarnations` 可选且只用于诊断。Ownership 权威是 Thread epoch counter 和当前 Lease row。

### 7.16 Credential Refs

```text
credential_ref TEXT PRIMARY KEY
provider TEXT NOT NULL
label TEXT NOT NULL
secret_store_backend TEXT NOT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
revoked_at INTEGER NULL
```

该表不包含 token、API key 或可还原 secret 的 payload。

### 7.17 Retention Jobs

```text
retention_job_id TEXT PRIMARY KEY
thread_id TEXT NOT NULL
retry_of_job_id TEXT NULL
status TEXT NOT NULL
phase TEXT NOT NULL
purge_after INTEGER NOT NULL
artifact_manifest_json TEXT NULL
attempts INTEGER NOT NULL
last_error TEXT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
terminal_at INTEGER NULL
```

Status 仅允许 `scheduled | executing | waiting | failed | completed | cancelled`。使用 partial unique index 保证同一 Thread 最多一个 `scheduled | executing | waiting` job；历史 terminal job 可以保留，因此再次 Delete 或人工重试 failed job 会创建带 `retry_of_job_id` 的新 job。该表不对 `threads` 建立级联外键，确保 Thread 主数据删除后 job 仍可完成审计和重试。Manifest 在 purge freeze transaction 中生成，只保存 storage ref/hash，不保存 artifact 内容或 secret。

## 8. 数据库约束

| 编号            | 约束                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| PERSIST-CON-001 | 一个 QueueItem 最多关联一个 resulting Run。                                         |
| PERSIST-CON-002 | `runs.source_queue_item_id` 唯一。                                                  |
| PERSIST-CON-003 | 同一 Thread 最多一个非终态 active Run。                                             |
| PERSIST-CON-004 | `(clientIdentity, commandId)` 唯一。                                                |
| PERSIST-CON-005 | Durable event sequence 在 Thread 内唯一且单调。                                     |
| PERSIST-CON-006 | Lease epoch counter 只递增，不随 release 删除。                                     |
| PERSIST-CON-007 | Secret 不得进入任意 JSON payload。                                                  |
| PERSIST-CON-008 | Late Observation 通过非 nullable `dedup_key` 去重。                                 |
| PERSIST-CON-009 | InputItem 和 LedgerEvent 不允许业务 UPDATE。                                        |
| PERSIST-CON-010 | Blocked Run 是非终态，必须继续占用 Thread activeRunId。                             |
| PERSIST-CON-011 | Operation 与 Command Deduplication 通过 client identity + command identity 可追踪。 |
| PERSIST-CON-012 | Plan Generation 在同一 Run 内唯一且单调。                                           |
| PERSIST-CON-013 | Queue revision 在 Thread 内单调递增，所有 Queue edit 使用 CAS。                      |
| PERSIST-CON-014 | Indeterminate blocker 不覆盖 Queue control state，解除后不得丢失用户暂停意图。       |
| PERSIST-CON-015 | Outbox stream basis 的 incarnation/sequence 必须同时为空或同时存在。                 |
| PERSIST-CON-016 | Execution config/policy revision 分别单调，Plan Generation 保存两者的不可变 snapshot。 |
| PERSIST-CON-017 | Operation target revision/snapshot 必须成对存在，恢复时不得回读 Thread 当前值替代。   |
| PERSIST-CON-018 | Operation parent 必须属于同一 Thread，且 operation tree 不得形成环。                  |
| PERSIST-CON-019 | Dispatch permitId 一次只绑定一个 ToolExecutionAttempt。                              |
| PERSIST-CON-020 | RetentionJob executing 后 Undelete 永久关闭，shared artifact 引用归零前不得删除。    |
| PERSIST-CON-021 | Artifact storage object 与 Thread 引用分离；对象仅在 reference count 为 0 时删除。   |
| PERSIST-CON-022 | Transcript draft 只作恢复 checkpoint，不能直接进入 canonical Context。              |
| PERSIST-CON-023 | ContextBoundary 不可变；Compaction 只能新建 boundary 并原子更新 current pointer。    |
| PERSIST-CON-024 | Model invocation 必须绑定单一 input ContextBoundary，stream 中途不得漂移。           |
| PERSIST-CON-025 | Plan Generation 的 tool schema artifact/hash 必须匹配，历史 descriptor 不可覆盖。   |

## 9. Transaction Writer

`WriteTransaction` 提供统一 helper：

```ts
interface WriteTransaction {
  appendLedger(event: NewLedgerEvent): LedgerCursor;
  appendOutbox(
    event: NewDurableEvent,
    streamBasis?: RuntimeStreamBasis,
  ): DurableCursor;
  createOperation(operation: NewOperation): void;
  updateOperation(update: OperationUpdate): void;
  saveCommandAck(record: CommandDedupRecord): void;
  assertLease(fence: ExecutionFence): void;
  nowEpochMs(): number;
}
```

每次语义转换生成一个 `transitionId`，关联 Projection、Ledger 和 Outbox。

## 10. Transaction Matrix

### 10.1 Thread Create / Fork

同一事务：Thread Projection、lineage、初始 Input/Context、Ledger、Outbox 和 Ack。只有需要异步初始化或外部协调时才创建 Operation。

Fork 只复制显式 committed boundary 的逻辑状态、config/policy snapshot 和新的 Thread-scope Artifact reference；新 Queue 为空且 control state active。不复制源 Queue、RuntimeSession、active Run、Operation、pending Approval、未终态工具或 transient stream。

### 10.2 Submission 入队

同一事务：

```text
verify Thread lifecycle = available
verify no threadArchive/threadDelete closing Operation
insert InputItem
insert QueueItem
increment Thread / Queue revision
append Ledger
append Outbox
save Ack
```

### 10.3 Submission 立即创建 Run

同一事务：

```text
verify Thread available
verify no threadArchive/threadDelete closing Operation
verify no active Run
verify Queue empty
verify Queue control active and no indeterminate blocker
verify no blocking Operation / critical indeterminate
assert current Lease fence
  or, only when no Lease row and no recovery-required state exists,
  atomically acquire a new epoch/incarnation in this transaction
insert InputItem
insert Run(status=starting)
insert PlanGeneration(0, current config/policy revisions and immutable snapshots)
set Thread.activeRunId
append Ledger + Outbox
save Ack
```

存在过期 Lease、未终态 Operation、未协调 ToolExecution 或 Late Observation 时，不属于可安全 acquire：`auto` 必须入队，`requireImmediate` 必须返回冲突，待 Takeover Recovery 完成后再调度。

### 10.4 Queue Dispatch

同一事务：

```text
verify Queue control active, no indeterminate blocker and no active Run
assert current Lease fence and recovery completed
select first queued QueueItem
insert Run(status=starting)
insert PlanGeneration(0, current config/policy revisions and immutable snapshots)
set Thread.activeRunId
set QueueItem consumed + resultingRunId
append Ledger + Outbox
```

### 10.5 Run Terminal

同一事务验证 Lease/Run fence，写 terminal status/reason/endedAt，清除 Thread.activeRunId，并写 Ledger/Outbox。`failed` 只在 Queue control state 原为 active 时改为 `pausedByFailure`；`completed` 不改 control state，Stop 使用独立规则保持 `pausedByStop`。

下一 QueueItem 的消费必须由 terminal transaction 提交后的新 actor message 执行，不能把下一 Run 的外部启动绑进同一 transaction。Crash 后由持久 Queue 和正常 dispatch 恢复。

### 10.6 Steer

Accepted transaction：验证并保存 target config revision/model snapshot、expected policy revision/effective snapshot、command、Operation、Steer InputItem、Run phase、Ledger、Outbox 和 Ack。

Applied transaction 在 quiesce/reconcile 完成后：验证 Lease、Run、expected generation 和 policy fence；递增 generation；绑定 accepted 时捕获的 execution config revision/model snapshot 和 policy snapshot。Accepted 后发生的普通 config change 或 policy relax 留给更晚 generation；若期间发生安全 policy tighten，则由合流的 Policy Reconcile 使用新 tightened snapshot。随后 expire 旧 Approval、提交 ContextItem、更新 Operation/Run，并写 Ledger 和 Outbox。

同一 Run 已存在非终态 Steer 时，target config/policy snapshot 完全相同的新 Steer 可以复用 `coordination_cycle_id`，InputItem 按 `accepted_ledger_sequence` 稳定排序并在一个 applied transaction 提交到同一新 generation；generation 只递增一次，各 Operation 分别记录同一个 appliedPlanGeneration。Snapshot 不同或已有 Stop intent 时返回 `OPERATION_CONFLICT`，不创建 Operation。

目标 Run 在 applied 前 terminal 时，`stalePolicy=enqueue` 在同一事务用原 Steer InputItem 创建队尾 QueueItem、递增 Queue revision、把 Operation 置为 completed/result=queueItemId，并写 Ledger/Outbox；`reject` 不创建 QueueItem并把 Operation 置为 cancelled。原 Steer InputItem 只有在 applied 或 fallback Run 消费时才能进入 Context，不能两边重复提交。

### 10.7 Stop

Accepted transaction：保存 Operation 和 Stop intent，先将 Queue control state 设为 `pausedByStop`，关闭 scheduling gate，把 Run 置为 `stopping`；同时按每个未 applied Steer 的 stalePolicy 将其 cancelled 或原子 fallback 入队，再写 Ledger、Outbox 和 Ack。若 reconciliation 发现关键 indeterminate，另行设置 blocker，不覆盖 `pausedByStop`。

Completed transaction：验证工具已终态或 indeterminate。Run 为 `stopped` 时清除 activeRunId；Run 为 `blocked` 时保留 activeRunId。随后更新 Operation、Ledger 和 Outbox。

### 10.8 Execution Config / Policy Change

Execution Config Change 使用 `expectedConfigRevision` CAS，递增 `executionConfigRevision`、保存新的非安全默认 config，并写 Ledger/Outbox/Ack。当前 Run 继续使用自己的 immutable model config snapshot，不创建 Operation；默认配置从下一 Run 生效。需要当前 Run 切换时，由后续显式 Steer 捕获目标 snapshot 并创建新 generation。

Server 在事务外对已验证的新旧 policy 做纯内存 canonical diff，并在 accepted transaction 中再次 CAS expected policy revision。

- 纯放宽：递增 `executionPolicyRevision`、保存新默认 policy、写 Ledger/Outbox/Ack；当前 Plan Generation 继续使用自己的 immutable policy snapshot，不创建 Operation。
- 安全收紧或 mixed change：递增 revision、创建 `policyReconcile` Operation、关闭 scheduling gate、expire 相关 Approval，并写 Ledger/Outbox/Ack。异步 reconcile 完成后创建绑定新 effective policy snapshot 的 Plan Generation，或将 Run/Operation 置为 blocked。

Stop、Steer 和 Policy Reconcile 可以保留各自 Operation row，但共享同一 Run 的 single-flight reconciliation cycle。每次 accepted/applied/terminal transition 仍分别提交 Projection、Ledger 和 Outbox；不得用第二个并行 executor 重复 drain 工具。

### 10.9 Tool Side Effect

数据库不能包住现实副作用：

```text
TX1: toolInvocation Operation + ToolExecution intent + Attempt + Ledger + Outbox
execute side effect with idempotency key
TX2: Observation + Tool/Attempt/Operation Projection + Ledger + Outbox
```

Crash 发生在 TX1 与 TX2 之间时由 Recovery 查询或标记 indeterminate。
需要 Approval 时，toolInvocation Operation 进入 `waiting/forApproval`；收到 decision 后由 actor推进，不保留等待中的 Promise。Tool settled outcome 推进 Operation terminal；Tool indeterminate 使 Operation blocked。

### 10.10 Approval Decision

CAS pending Approval，验证 Thread、Run、Plan Generation、Policy Revision 和 Lease Fence；更新 Approval/Operation，写 Ledger、Outbox 和 Ack。迟到决定返回 stale。

### 10.11 Lease Transition

Acquire、Takeover、Drain 和 Release 的 Projection、Ledger、Outbox 必须同事务；Heartbeat 只 CAS Lease row。

### 10.12 Late Observation Resolve

Inbox receive 只做幂等 INSERT，不修改主 Projection。当前 owner resolve 时验证 schema、source、Tool/Attempt identity 和现实证据；若事实与 settled Tool outcome 冲突，同一事务将 Tool 置为 `indeterminate`、递增 revision、设置 Queue blocker、创建或推进 `lateObservationReconcile` Operation，并写 Ledger/Outbox。若关联 Run 已 terminal 且 Queue control state 原为 active，同时改为 `pausedByFailure`。证据收敛后再事务写新的 settled outcome 和 `reconciled_at`。

关联 Run 若仍非终态，可以进入 recovering/blocked；若已经 terminal，只追加 post-terminal correction fact/reference，不修改 Run status 或 endedAt。

只有当前 Thread 已不存在其他 critical indeterminate 时才能清除 blocker；清除只揭示既有 control state，不自动把 `pausedByStop | pausedByUser | pausedByFailure` 改为 active。

### 10.13 Checkpoint Apply

Accepted transaction 先验证 Thread available、无 active Run、无冲突性 workspace Operation，并 assert 或安全 acquire Lease；随后创建 system InputItem、暂停 Queue、创建 Operation 和特殊 Run、记录 workspace precondition、Ledger、Outbox 和 Ack。文件操作在 workspace lock 内、数据库事务外执行。Observation transaction 保存实际结果和 reconciliation。

### 10.14 Archive、Unarchive、Undelete 和 Delete

Archive/Delete 必须先验证无 active Run 和冲突性 workspace Operation。无 Lease 时在同一事务更新 lifecycle、把 Queue control state 设为 `pausedByUser`（不清 blocker），Delete 同时创建 `scheduled` RetentionJob，并写 Ledger/Outbox/Ack。存在 idle Lease 时，accepted transaction 只关闭 scheduling gate、创建 `threadArchive | threadDelete` Operation 和 Ack；Lease drain/release 完成后，terminal transaction 再提交上述 lifecycle/retention 变更。两步均不得隐式 Stop active Run。

Unarchive/Undelete 恢复为 available 但不自动恢复 Queue；Undelete 仅在 purge 未开始时允许，并把当前 scheduled job 置为 cancelled。Undelete 始终创建可审计的 `threadUndelete` Operation，即使它在同一事务内完成。物理 purge 由 RetentionJob 驱动。

### 10.15 Retention Purge

Purge 使用独立 `retention_jobs`，不在 SQLite transaction 中删除外部文件：

```text
TX1: verify deleted + purge_after + no Lease/active Run/nonterminal Operation
     snapshot unshared artifact manifest
     set threads.purge_started_at
     retentionJob -> executing/cleaningArtifacts
outside TX: idempotently delete only refs with zero external Thread reference
TX2: verify manifest/refcounts again
     delete Thread child rows and Thread row
     retentionJob -> completed
```

TX1 提交后 Undelete 返回 `THREAD_PURGE_STARTED`。任一阶段 crash 后按 job phase 和 manifest 重试；外部删除失败使 job waiting/failed，不得跳过后宣称 purged。共享 content-addressed artifact 只减少引用，不删除仍被 Fork/其他 Thread 引用的对象。

## 11. Outbox Publisher

- Publisher 只读取 pending rows、发布、再标记结果。
- 发布语义为至少一次；客户端按 `eventId` 去重。
- 发布失败不得回滚已经提交的 Projection。
- Publisher 不持有 Thread actor 或 workspace lock。
- Outbox 是 durable live/replay 的唯一来源；Publisher 将 row 按 Thread sequence 送入对应 EventMux，Actor 不额外发送重复 durable payload。
- 与 runtime stream 有因果关系的 Outbox row 保存 actor 在 semantic transition 前捕获的 `streamBasis`；Publisher/EventMux 不得越过该 basis 提前交付 terminal durable event。
- Events endpoint 直接使用 Outbox 作为 durable replay source，并在 retention watermark 前保留记录。
- Retention 必须先生成可替代旧事件的 Snapshot watermark，再删除更早 Outbox rows。

## 12. Consistent Snapshot Read

Snapshot 数据库部分必须在单个 read transaction 中读取：

- Thread、Run、Queue、Operation、Approval 和 Transcript page。
- 当前 durable high-watermark。
- Projection revision 和 snapshot version。

Runtime stream 与数据库 Snapshot 的跨层 barrier 由 Runtime 规范定义。网络发送不得持有数据库 transaction。

## 13. Legacy Data Import

### 13.1 原则

- 一个旧历史快照导入为一个 Thread，并保存 legacy alias。
- 历史用户输入转为 InputItem；用户可见内容转为 TranscriptItem。
- 可安全识别的稳定内容转为 ContextItem。
- 无法还原真实工具生命周期的旧记录转为 synthetic imported Run，不伪造 ToolExecution。
- 旧未完成任务导入为 `failed` 或 `stopped`，不创建 RuntimeSession。
- 旧 audit 和 checkpoint 转为 Ledger/reference。
- 不长期双写旧表和新表。

### 13.2 验证

- 导入前后 Thread、消息、checkpoint 和 audit 数量校验。
- 每个导入单元保存 source hash 和 import result。
- 单条损坏记录进入 quarantine，不阻塞其他 Thread 导入。
- 旧表至少保留一个稳定版本为只读备份。

## 14. 实现阶段

阶段编号以 [2.0 Implementation Roadmap](../plans/2026-07-10-colorful-code-2-implementation-roadmap.md) 为唯一来源。Persistence 在各阶段的交付为：

```text
Phase 0A: Data-directory Instance Lock + Migration Framework + DatabaseProvider + Clock
Phase 0B: Contract enums/schema inputs（由 Contract 规格主导）
Phase 0C: Thread Identity + Input + Operation + Dedup + Ledger + Outbox
Phase 0D: 为 ThreadActor/EventMux 提供 repository 与 snapshot transaction
Phase 0E: Worker Registry + Lease + Late Observation Inbox
Phase 1: Run + Queue + Tool + Approval + Transcript + Checkpoint Projections
Phase 6: Legacy Importer + Integrity Verification
```

## 15. 验收标准

- 所有 `PERSIST-CON-*` 有数据库 constraint 或事务测试。
- 每个 Transaction Matrix 条目都有 crash-before/after 测试。
- 故障注入覆盖 `SQLITE_BUSY`、Outbox 未发布、进程中止和备份恢复。
- Transaction callback 静态检查或测试禁止外部 side effect。
- Migration 在空数据库、当前生产数据库和损坏 fixture 上验证。
- Projection、Ledger 和 Outbox 不存在已知不一致窗口。
