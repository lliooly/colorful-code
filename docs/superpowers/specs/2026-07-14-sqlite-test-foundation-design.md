# Phase 0A SQLite Test Foundation 设计

> **状态：待实现**
>
> 本文档定义 Phase 0A 最后三项工作的统一设计：SQLite Configuration、Test Database Factory 和 1.x Schema Baseline。本文档细化并补充既有 Persistence Foundation、Migration Framework、Backup Recovery 与 Database Kernel 设计；发生冲突时，以本文档对本分支范围内行为的明确规定为准。

## 1. 目标与范围

本分支完成 Phase 0A 持久化基础设施的收口：所有 SQLite 连接使用按角色定义、可验证的统一策略；测试通过一个隔离且可故障注入的数据库工厂启动完整生命周期；当前生产 1.x Schema 和代表性数据被固化为不可回改的兼容基线。

完成后的启动链路固定为：

```text
解析数据库路径
→ 获取 Data-directory Instance Lock
→ 使用受限 bootstrap connection 识别 Schema
→ 创建一致性备份
→ 执行 forward-only migration
→ 关闭 bootstrap connection
→ 初始化 DatabaseProvider
→ 验证业务连接 SQLite policy
→ 开放业务服务
```

关闭链路固定为：

```text
停止接收业务操作
→ 有界 WAL checkpoint
→ 关闭 Provider 连接
→ 释放 Provider ownership
→ 释放 Instance Lock
```

本分支不实现 Phase 0B Contract enums、2.0 业务表、Ledger、Outbox、Repository、Lease、fencing、worker registry、正式 Legacy Importer、down migration、用户历史备份自动清理、多进程共享写入或未使用的未来表。

## 2. 架构边界

实现拆分为三个相互依赖但职责单一的边界：

```text
SQLite Connection Policy
├─ read-write policy
├─ read-only policy
├─ migration-bootstrap policy
├─ capability diagnostics
└─ bounded checkpoint

Test Database Factory
├─ isolated data directory
├─ independent Instance Lock
├─ deterministic scenario preparation
├─ migration and Provider startup
├─ controlled Database Clock
└─ aggregate cleanup

1.x Schema Baseline
├─ canonical schema SQL
├─ machine-readable manifest
├─ immutable checksum
├─ deterministic fixtures
└─ application/schema version map
```

`SQLite Connection Policy` 是生产连接配置的唯一入口。Repository、Store、Service 和其他业务模块不得执行 PRAGMA，不得直接打开 SQLite，也不得修改 journal mode。

`Test Database Factory` 位于 `apps/server/test/support`，只组合公开生产生命周期和明确命名的测试故障点。它不从 `apps/server/src/persistence/index.ts`、Nest production module 或生产构建入口导出。

`1.x Schema Baseline` 来自当前生产建库 SQL 和对真实 SQLite 数据库的 introspection 结果，不凭记忆重写近似 Schema。baseline 资产一旦发布，其 migration source、migration checksum、manifest checksum 和 fixture contract 均不可原地修改；兼容变化必须追加 migration 或新的 fixture 版本。

## 3. SQLite Connection Policy

### 3.1 连接角色

所有连接在打开时必须声明以下角色之一：

- `business-read-write`：`DatabaseProvider` 持有的业务连接。
- `business-read-only`：诊断、验证或未来明确只读用途的连接。
- `migration-bootstrap`：只在持有 Instance Lock 时用于 Schema 识别、备份、migration 和恢复验证的短生命周期连接。

Instance Lock 自己的锁数据库不是业务数据库。它继续使用独立的 `busy_timeout = 0` 和锁协议，不纳入业务连接 policy。

### 3.2 固定配置

| PRAGMA           | 业务读写                | 业务只读                     | Migration bootstrap     |
| ---------------- | ----------------------- | ---------------------------- | ----------------------- |
| `foreign_keys`   | `ON`，回读验证          | `ON`，回读验证               | `ON`，回读验证          |
| `journal_mode`   | 设置 `WAL` 并验证返回值 | 不修改，只验证数据库为 `WAL` | 设置 `WAL` 并验证返回值 |
| `synchronous`    | `FULL`，回读为 `2`      | `FULL`，回读为 `2`           | `FULL`，回读为 `2`      |
| `busy_timeout`   | `250ms`                 | `250ms`                      | `1000ms`                |
| `temp_store`     | `MEMORY`，回读为 `2`    | `MEMORY`，回读为 `2`         | `MEMORY`，回读为 `2`    |
| `trusted_schema` | `OFF`，回读为 `0`       | `OFF`，回读为 `0`            | `OFF`，回读为 `0`       |
| `query_only`     | `OFF`                   | `ON`，回读验证               | `OFF`                   |

`synchronous = FULL` 保持既有 Persistence Foundation 的耐久性选择。在没有独立性能基准、断电故障测试和规范变更前，不在本基础设施收口分支降级为 `NORMAL`。

只读连接不得尝试切换 journal mode。它必须验证文件已经处于 WAL；若不是 WAL，则明确失败，不能静默接受 `delete`、`truncate`、`persist`、`memory` 或 `off`。

所有 PRAGMA 都必须在每条新连接上执行或验证。`foreign_keys` 是 per-connection 设置，不能因为另一个连接已启用而跳过。Provider 重启、多连接测试和只读连接测试均检查这一不变量。

### 3.3 配置应用与失败语义

Policy API 接受原始 SQLite connection 和角色，顺序执行安全设置并回读实际值。`journal_mode = WAL` 必须读取该语句返回的 mode，并再次查询当前 mode；两者都必须为大小写无关的 `wal`。

以下情况抛出结构化 `SqliteConfigurationError` 并中止启动：

- WAL 请求返回非 `wal`；
- 任一安全 PRAGMA 无法执行、无法回读或实际值不匹配；
- 只读连接观察到非 WAL 数据库；
- SQLite 版本或编译能力低于受支持基线；
- 运行时缺少必须的 backup 能力；
- 配置 API 收到未知连接角色或无效等待预算。

错误包含稳定的 `code`、连接角色、PRAGMA 名称、期望值和经过过滤的实际值；不包含数据库路径、SQLite URI、凭据、环境变量或连接字符串。

### 3.4 Busy timeout 与 Transaction retry

业务连接的 SQLite `busy_timeout` 固定为 250ms，用于吸收非常短的锁交接。Transaction API 的显式 retry 继续只处理 `SQLITE_BUSY` 和 `SQLITE_LOCKED`，但新增总预算验证：

```text
(maxRetries + 1) × 250ms
+ 所有退避的最大累计值
≤ 2000ms
```

超过 2000ms 的 retry options 在执行 callback 前以 `RangeError` 拒绝。默认无 retry；只有调用方显式声明可安全重放时才启用。每次尝试仍先取得 `BEGIN IMMEDIATE`，因此在开始事务前发生的 busy 不会执行 callback；事务内发生 busy 时 rollback 后才允许下一次尝试。测试必须用幂等约束和可观察计数证明最终只产生一次业务状态变化。

Migration bootstrap 使用 1000ms timeout，但不使用业务 Transaction retry。daemon 已持有 Instance Lock，若仍持续 busy，应进入明确的 migration/backup failure，而不是无限等待。

### 3.5 SQLite 能力与诊断

启动时生成不可变的 `SqliteDiagnostics`：

```ts
type SqliteDiagnostics = Readonly<{
  sqliteVersion: string;
  connectionRole: SqliteConnectionRole;
  journalMode: 'wal';
  foreignKeys: true;
  backupMethod: 'online-backup' | 'vacuum-into';
  returningSupport: boolean;
  compileOptions: readonly string[];
}>;
```

能力探测至少覆盖：

- `sqlite_version()`；
- WAL 实际启用结果；
- foreign key enforcement 实际结果，并拒绝 `OMIT_FOREIGN_KEY` / `OMIT_TRIGGER`；
- 当前 Bun SQLite driver 是否提供 Online Backup，以及 SQLite 是否提供仓库现有受控 `VACUUM INTO` 一致性 fallback；诊断记录实际选用的方法；
- SQLite `RETURNING` 语法所需版本，供后续 Phase 使用；
- 与安全边界相关的编译选项。

当前 Bun 1.3.14 没有暴露 Online Backup 方法，因此本阶段的预期诊断方法是 `vacuum-into`。只有 Online Backup 和 `VACUUM INTO` 都不可用时才以缺少 backup capability 拒绝启动；不能因为驱动未暴露 Online Backup 而否定已经验证的一致性 fallback。

诊断只保存版本、布尔能力、备份方法、连接角色、固定配置和编译选项名称。任何可能包含用户目录、数据库文件名、URI query、token 或 credential 的文本都必须过滤。诊断序列化测试使用带敏感路径和伪凭据的输入验证输出不泄漏。

### 3.6 Provider checkpoint 与关闭

`DatabaseProvider.close()` 首次调用立即将状态变为 `closing`，拒绝新的 read、transaction 和 clock 操作。关闭协调器只执行一次物理关闭，重复调用返回同一个 Promise。

关闭业务连接前执行一次 `PRAGMA wal_checkpoint(PASSIVE)`。结果结构化为：

```ts
type WalCheckpointResult = Readonly<{
  status: 'completed' | 'incomplete' | 'interrupted';
  sqliteBusy: boolean;
  logFrames: number;
  checkpointedFrames: number;
  remainingFrames: number;
}>;
```

SQLite 返回的 `busy` 是 0/1 标志，不是 frame 数；而且长读事务阻止部分 frame checkpoint 时，`PASSIVE` 可能返回 `busy = 0` 但 `checkpointed < log`。因此 `completed` 只由 `logFrames === checkpointedFrames` 判定，`incomplete` 表示仍有 frame，`remainingFrames` 为非负差值，`sqliteBusy` 单独保存 SQLite 原始标志。`interrupted` 只用于明确的关闭中断，不伪装为 SQLite busy。

`PASSIVE` 不强制等待 reader，不使用无界循环。返回 incomplete 时记录结果并继续关闭；SQLite 报错或测试注入关闭中断时仍尝试关闭连接。checkpoint error、connection close error 和 ownership release error 按发生顺序进入 `AggregateError`，原始错误不被后续清理错误覆盖。

Provider 使用 active-operation lease 协调关闭：`close()` 首次调用立即拒绝新操作，但必须等待已进入的 read 或 transaction attempt 离开后再 checkpoint 和物理 close。read、transaction callback 或 Database Clock 内重入调用 `close()` 只获得一个待完成 Promise，不能同步关闭当前连接；正在 retry sleep 的 transaction 不得开始下一次 attempt。transaction ownership 覆盖整个 retry Promise，因此等待期间第二个 transaction 仍以 concurrent/nested error 拒绝。

启动和关闭均禁止自动执行 `VACUUM`。备份模块现有的受控 fallback 不等于启动时维护性 VACUUM，仍受其独立一致性和边界约束。

## 4. Test Database Factory

### 4.1 公开测试接口

工厂的默认返回值为：

```ts
type TestDatabase = {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly provider: DatabaseProvider;
  readonly clock: TestDatabaseClock;
  close(): Promise<void>;
};
```

`TestDatabaseClock` 实现生产 `DatabaseClock`，以安全整数 epoch milliseconds 初始化，并允许测试通过同步 `set()` 和 `advanceBy()` 控制时间。持久化时间仍必须由 transaction context 的 `now` 或 Provider clock 读取，测试不得把 wall clock 直接写入数据库。

工厂默认创建独立的 `mkdtemp` 数据目录、固定 Clock、真实 Instance Lock、真实 migration 和真实 Provider。每次调用产生不同数据库文件和锁文件；并行测试不共享目录、Provider ownership、计时器或锁。

### 4.2 场景模型

工厂通过判别联合类型支持以下场景：

- `empty`：不存在数据库文件，由完整启动链创建。
- `migrated`：已经应用当前 migration registry 的数据库。
- `legacy-v1`：当前正常 1.x fixture，可选择 normal、missing-optional 或 orphaned 变体。
- `schema-version`：应用到指定已知 migration version；未知版本在工厂入口拒绝。
- `corrupt-migration`：metadata checksum、migration history 或数据库完整性损坏。
- `wal-uncheckpointed`：主文件与 WAL 中存在未 checkpoint 的已提交数据。
- `busy-lock`：第二条测试专用 connection 持有受控写锁。
- `read-only`：文件权限和 connection role 都明确只读；返回的 Provider 允许 read，transaction 明确拒绝。

工厂不为尚不存在的 2.0 Schema 伪造版本。feature flag 关闭时，所有场景都只能产生 1.x 表和 migration metadata，不产生 2.0 业务写入。

### 4.3 故障注入

工厂提供类型化 options 注入以下边界：

- 在指定 migration version 前或 migration callback 内失败；
- 持有和释放真实 SQLite write lock，以稳定产生 `SQLITE_BUSY`；
- checkpoint 返回 completed、busy、interrupted 或抛错；
- Provider close、Instance Lock release 或临时目录清理失败。

故障点必须命名为测试能力，不得通过任意 callback 暴露整个 Provider 内部依赖图。生产入口无法接受这些 options。

### 4.4 原始 SQLite 测试访问

只有专门验证 SQLite 配置、Schema introspection、WAL 或 lock 行为的测试可以使用：

```ts
withRawTestConnection<T>(
  database: TestDatabase,
  role: 'read-only' | 'lock-holder',
  operation: (connection: Database) => T,
): T;
```

该 API 位于测试 support 模块，名称明确包含 `RawTestConnection`。connection 只在 callback 内有效并在 finally 中关闭，不放入 `TestDatabase` 句柄，也不允许测试保存后继续使用。普通业务读写测试只使用 Provider facade。

### 4.5 清理与错误保留

工厂按依赖顺序跟踪它创建的资源：先取消计时器并释放 busy/raw connection，再关闭 Provider；只有 Provider 连接已确认关闭才释放 Instance Lock；只有连接和锁均确认释放才删除临时目录。`close()` 幂等，重复调用共享同一 Promise。不能在 Provider close 失败且物理连接状态未知时继续删除打开的数据库或释放 daemon ownership lock。

用于测试清理错误聚合的 fault 在真实资源成功释放后再抛出 synthetic error，既能证明错误顺序，也不会故意遗留连接、锁或目录。

测试 helper 捕获测试主体错误后仍执行清理。若主体和清理都失败，抛出 `AggregateError([bodyError, ...cleanupErrors])`；若只有清理失败，则抛出按资源逆序排列的清理错误。清理失败不得掩盖原始测试失败。

目录删除前必须确认 Provider 和所有原始连接已关闭、计时器已取消、lock 已释放。测试通过重新获取同一 lock、重新打开数据库和检查目录不存在来验证清理，而不是依赖内部布尔标记。

### 4.6 生产构建隔离

以下门禁同时存在：

- 测试工厂文件只位于 `apps/server/test/support`；
- 生产 `src` 不得 import 测试工厂或 fixture generator；
- `persistence/index.ts` 和 Nest modules 不导出测试 factory；
- `database-provider.testing.ts` 和 `createInternalTestDatabaseProvider` 从生产 `src` 移入 test support，当前已存在的测试 hook 不再进入 `dist`；
- production build 先清理旧产物，构建完成后扫描输出，不得出现 `.testing`、`createTestDatabase`、`withRawTestConnection`、`createTestDatabaseProvider`、`TestDatabaseProviderOptions` 或 fixture 路径；
- lint 和 typecheck 使用可工作的 Bun ESM 测试配置覆盖 test support、新 Gate 测试和 build verifier，不能只检查 `src`；
- 数据库访问边界测试继续限制 `bun:sqlite` 和 Provider internals 的允许位置。

## 5. 1.x Schema Baseline

### 5.1 权威来源

当前生产 1.x Schema 的权威来源是已经发布并由 `openDatabase()` 使用的 `SCHEMA_DDL`，并通过真实 SQLite 建库后 introspection 验证。实现时将其移入只负责 baseline 的生产模块，使以下消费者共享同一份 canonical SQL：

- baseline migration；
- Schema manifest 生成与验证；
- deterministic fixture generator；
- 1.x compatibility tests。

Provider 初始化不再执行散落的 `CREATE TABLE IF NOT EXISTS`。Schema 创建只通过 Migration Framework 发生，消除“migration 成功后 Provider 又偷偷补表”的旁路。

### 5.2 Manifest 与 checksum

机器可比较 manifest 由 SQLite introspection 生成，至少包含：

```text
tables
  name
  columns: cid, name, declared type, not-null, default, primary-key position
  foreign keys: referenced table/columns, on-update, on-delete, match
indexes
  name, table, uniqueness, origin, partial, ordered columns
triggers
  name, table, normalized SQL
pragma user_version
normalized sqlite_schema SQL
```

数组按稳定 key 排序，SQL 统一换行、空白和结尾分号后使用 canonical JSON 序列化。`legacySchemaChecksum` 是 canonical manifest 的 SHA-256，不依赖 SQLite 文件页号、rowid、WAL frame、文件时间或绝对路径。

Schema checksum 分为两个命名明确的概念：

- `legacySchemaChecksum`：只覆盖已冻结的 1.x 业务对象，不包含 `schema_migrations`；迁移前后必须相同。
- `databaseSchemaChecksum`：覆盖当前程序管理的全部 Schema，包括 migration metadata；用于重启和当前版本验证。

当前 1.x Schema 没有声明 foreign key constraint 和 trigger。manifest 必须忠实记录空集合，不能为了未来设计修改历史。现有索引和 SQLite 自动索引必须按 origin 分开记录。

### 5.3 版本轴与 baseline adoption

当前已发布 1.x 数据库的真实 `PRAGMA user_version` 为 `0`。该值作为历史事实记录，baseline migration 不把它伪装为应用版本，也不为了方便识别而修改。

Migration Framework 使用独立版本轴：

```text
1.x application family
→ PRAGMA user_version = 0
→ legacySchemaChecksum = frozen value
→ migration registry version = 1 / legacy_1x_baseline
```

bootstrap 在创建 migration metadata 之前先分类数据库：

- 空数据库：运行 migration 1，创建 canonical 1.x Schema 并登记 checksum。
- 已有 1.x Schema、没有 migration metadata：完整 manifest 匹配后 adoption；先创建一致性备份，再在 `BEGIN IMMEDIATE` 内复验 manifest 和 metadata 仍未出现，只创建 migration metadata 并登记 migration 1，不重复执行 baseline DDL。
- 已有完整 1.x Schema 和合法但为空的 migration metadata：视为 adoption metadata 写入中断，在事务内复验后补 migration 1 记录。
- 只有 migration metadata、没有 1.x 业务对象：视为空库初始化中断，migration 1 创建 baseline DDL。
- 已有合法 migration metadata：按正常 checksum 和 forward-only 规则验证。
- metadata 表示比程序更新的版本：抛出 `database_newer_than_program`。
- 业务对象存在但 manifest 不匹配任何受支持 1.x baseline：拒绝 adoption，进入明确的 incompatible/corrupt recovery 路径。

历史应用版本与 Schema 版本的映射以数据文件记录并由测试校验。未知应用版本不能仅凭字符串猜测 Schema；数据库结构和 migration metadata 才是识别权威。

### 5.4 Fixture 内容与隐私

正常 1.x fixture 至少包含代表性的：

- `SessionSnapshot`，只保留验证读取合同所需的最小非敏感结构；
- parent/child Checkpoint、排序字段、label、summary 和空 file changes；
- 多条有确定顺序的 Audit；
- Project 和 Session metadata；
- installed plugin/model configuration 的非敏感字段；
- 用于验证现有服务关联删除语义的数据：删除 Session 会删除其 checkpoint、audit 和 metadata；删除 Project 会把关联 metadata 的 `project_id` 置空。

fixture 不包含真实 API key、token、credential、用户主目录、绝对 workspace 路径、真实聊天内容、邮箱或个人标识。路径使用明确的虚构相对标识；文本只描述 fixture 目的。

另提供：

- `missing-optional`：nullable 字段为 null，JSON 中缺少历史上可选字段，并包含旧格式但仍可读取的值；
- `orphaned`：利用 1.x 没有数据库 foreign key 的历史事实，包含孤立 session metadata/checkpoint 等异常记录；
- `corrupt`：完整性、migration checksum 或不可解析关键 payload 的受控损坏，用于验证恢复/拒绝，不供正常业务读取。

“历史上允许但格式不理想”和“数据库不可信”必须区分。前者在 migration 中保留并由未来 Legacy Importer 隔离到单记录级别；后者阻止 Provider 启动，不能继续写入。

### 5.5 确定性与 WAL 状态

fixture generator 使用固定 ID、固定 Database Clock、固定插入顺序和 canonical JSON。确定性比较使用：

- manifest checksum；
- 每张表按稳定 key 排序后的 canonical rows checksum；
- 两者组合得到 fixture logical checksum。

不直接比较 `.db` 文件 SHA-256，因为 SQLite header change counter、页布局和 WAL checkpoint 时机会造成与逻辑内容无关的差异。

WAL fixture 必须在第二条连接仍可观察 WAL 时提交数据并保留未 checkpoint frame。备份测试证明只复制 main database 文件会遗漏该数据，而 Online Backup 或受控一致性 fallback 会包含该数据。manifest 记录 fixture 的预期 WAL 状态，但不把易变 frame 数纳入逻辑 checksum。

## 6. Migration 与恢复闭环

正式 registry 新增且冻结 migration 1：`legacy_1x_baseline`。它的 source、name、version 和 checksum 一经发布不得修改。

完整流程为：

```text
获取 Instance Lock
→ 应用 migration-bootstrap SQLite policy
→ 探测 SQLite capabilities
→ 分类 empty / legacy 1.x / managed / newer / corrupt
→ 对 pending migration 创建一致性备份
→ 执行 migration 1 或后续 migration
→ integrity_check + foreign_key_check + schema checksum
→ 关闭 bootstrap connection
→ 创建并配置 Provider
```

正常 1.x 数据库 adoption 不运行 baseline DDL，也不改变 1.x 业务数据。migration 前后分别计算 `legacySchemaChecksum` 和各表 logical rows checksum，必须与冻结值一致；migration 后的 `databaseSchemaChecksum` 必须与当前 registry 预期一致。虽然 daemon 持有合作进程使用的 Instance Lock，adoption 事务仍必须复验，因为第三方 SQLite connection 不受该锁协议约束。

损坏 fixture、baseline manifest 不匹配、migration checksum 被修改或 post-migration 验证失败时，沿用既有 quarantine + atomic restore 流程，恢复后仍以 migration failure 退出。较新版本明确拒绝，不尝试 downgrade、覆盖 metadata 或继续业务写入。

## 7. 联合集成测试

新增真实生命周期集成测试执行：

```text
Test Database Factory
→ 创建 1.x Schema fixture
→ 获取真实 Instance Lock
→ 创建真实一致性备份
→ 执行真实 Migration Framework
→ 初始化真实 DatabaseProvider
→ 应用并验证 SQLite Configuration
→ 执行 Transaction API
→ 使用固定 Database Clock
→ checkpoint 并完整关闭
→ 再次启动验证
```

至少覆盖：

1. 空数据库完整启动、写入、关闭和重启。
2. 正常 1.x 数据库 adoption 后数据可由当前 1.x code 读取。
3. WAL 中有未 checkpoint 数据时，备份和 migration 后数据仍完整。
4. migration 前后 `legacySchemaChecksum` 不变，当前 `databaseSchemaChecksum` 正确。
5. Provider 新连接、重启连接和只读连接使用各自统一 PRAGMA。
6. 真实 foreign key fixture 中的非法写入被阻止；1.x manifest 同时保持“无历史 FK”的事实。
7. busy timeout 与 retry 总预算受限，最终业务状态只变化一次。
8. Provider、原始测试连接、计时器、Instance Lock 和临时目录全部释放。
9. 同一 fixture 多次生成和多次迁移得到相同逻辑 checksum。
10. 损坏 fixture 进入恢复/拒绝流程，不初始化 Provider。
11. 较新 migration Schema 被明确拒绝。
12. `COLORFUL_CODE_V2_ENABLED` 关闭时不存在 2.0 表或业务写入。
13. missing-optional 与 orphaned 历史记录不会使 baseline adoption 或 migration 进程崩溃。
14. 当前 1.x `user_version = 0` 不会被错误识别为未知新版本。

## 8. Phase 0A Gate 与 invariant 映射

建立机器可检查的 invariant manifest，将每个稳定 ID 映射到至少一个测试文件和完整测试名：

| Invariant        | 验收要求                                                      |
| ---------------- | ------------------------------------------------------------- |
| `P0A-LOCK-001`   | 第二个 daemon 不能打开相同数据目录；不同目录可并行运行        |
| `P0A-MIG-001`    | migration 只按 registry 固定顺序向前执行                      |
| `P0A-MIG-002`    | 已应用 migration checksum 改变时拒绝启动                      |
| `P0A-REC-001`    | migration 失败恢复一致性备份并保持 not-ready                  |
| `P0A-FIX-001`    | empty、1.x 和 WAL fixture 全部通过完整生命周期                |
| `P0A-PROV-001`   | 所有业务数据库访问经过 DatabaseProvider                       |
| `P0A-TX-001`     | 所有业务写入经过 Transaction API，callback 同步且无外部副作用 |
| `P0A-CLOCK-001`  | 所有持久化时间来自 Database Clock                             |
| `P0A-SQL-001`    | 每条业务连接应用并验证统一 SQLite policy                      |
| `P0A-BUSY-001`   | `SQLITE_BUSY` 和 retry 不重复业务副作用且总等待有界           |
| `P0A-CLOSE-001`  | Provider 关闭释放连接、ownership、Instance Lock 和测试资源    |
| `P0A-V2-001`     | feature flag 关闭时没有 2.0 业务写入                          |
| `P0A-COMPAT-001` | `main` 合并后现有 1.x 功能和 fixture 读取继续工作             |

测试映射检查拒绝未知 invariant、重复 ID、缺少测试文件、缺少完整测试名或指向不存在的测试。测试文件重命名时必须同步更新映射。

## 9. 验证命令

实现完成后必须从仓库根目录执行并检查退出码：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format
```

SQLite、factory、baseline 和 Phase 0A Gate 的目标测试应在开发过程中按 TDD 单独执行；最终结论只能基于上述完整、最新的验证结果。

## 10. 兼容性与后续工作

本分支不改变 1.x HTTP/API 行为，不转换 1.x 业务数据，不创建 2.0 业务表。主要兼容性变化是 Schema 初始化从 Provider 的幂等 DDL 移到正式 baseline migration；daemon 外的旧测试 helper 迁移到统一 Test Database Factory。

Phase 0A Gate 全部通过并合并后，下一分支进入 Phase 0B：Contract Enums、Schema Authoring Foundation 和 Generated Artifact Drift Checks。Phase 0B 只能依赖本分支冻结的 migration、SQLite policy 和测试工厂，不得回改 1.x baseline。
