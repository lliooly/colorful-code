# Migration Bootstrap Connection + Migration Framework

> **Status: Approved for implementation**
>
> 本文档细化 Colorful Code 2.0 Phase 0A 的第二项：在 Instance Lock 与业务数据库连接之间建立最小权限 SQLite migration bootstrap connection 和 forward-only migration framework。

## 1. 范围

本项实现：

- 在打开任何业务数据库连接前获取并持有 Instance Lock。
- 使用只负责迁移元数据和 migration SQL 的 `bun:sqlite` bootstrap connection。
- daemon 与 bootstrap 当前只接受持久化文件数据库路径。
- 注册、校验并按固定顺序执行 forward-only migrations。
- 记录 Schema 版本、migration ID、checksum、执行时间点和耗时。
- 拒绝 checksum 漂移和数据库版本高于当前程序的启动。
- 保证重复启动不会重复执行 migration。
- migration 失败时关闭 bootstrap connection，保留可识别的错误状态并释放 Instance Lock。

本项不实现：

- 完整 `DatabaseProvider`、业务 Repository 或 2.0 业务表。
- 1.x baseline 或 Legacy Importer。
- migration 前自动备份、失败后恢复及其闭环。
- down migration。
- 内存数据库的连接移交。短生命周期 bootstrap connection 关闭后，业务应用无法继续访问同一个内存数据库；该能力留给后续 `DatabaseProvider` 或 Test Database Factory。

`runMigrations()` 是独立执行器，仍支持测试直接传入真实的内存 `Database`。限制只适用于需要把数据库从 bootstrap 阶段移交给业务应用的生产启动流程。

## 2. 启动顺序

`startDaemon()` 是启动资源顺序的唯一编排点：

```text
resolve data directory
-> acquire Instance Lock
-> open bootstrap connection
-> run migrations
-> close bootstrap connection
-> create Nest application (business connections may open here)
-> listen
```

启动路径必须是持久化文件数据库。`''`、`:memory:`、`file::memory:` 和 `file::memory:?<query>` 在获取 Instance Lock、创建目录或打开连接前 fail closed，并抛出稳定的 `in_memory_database_unsupported` 错误。原因是短生命周期 bootstrap connection 无法把内存数据库移交给后续业务连接；本阶段不增加 keeper connection 或连接移交机制。文件数据库的父目录在 bootstrap connection 打开前创建。

任何 migration 错误都发生在 `createApplication()` 之前，因此不会打开业务数据库。失败路径关闭 bootstrap connection，再由现有 daemon cleanup 释放 Instance Lock。若关闭或释放也失败，保留原始 migration 错误并通过 `AggregateError` 附带 cleanup errors。

## 3. Migration 注册模型

每个 migration 定义：

```ts
interface Migration {
  readonly version: number;
  readonly name: string;
  readonly source: string;
  up(database: MigrationDatabase): void;
}
```

- `version` 是严格递增的正安全整数，也是该 migration 成功后的 Schema 版本。
- `name` 是稳定且唯一的 migration ID。
- `source` 是稳定、显式、可审查的 migration 内容，不使用 `Function.prototype.toString()`。
- `up` 必须同步，只能通过受限的 migration database facade 执行 SQL。
- registry 声明顺序就是执行顺序；初始化时拒绝乱序、重复 version 和重复 name。

checksum 使用 SHA-256，对带长度边界的 `version`、`name` 和 `source` 规范编码计算。修改任何已发布 migration 的身份或内容都会导致 checksum 不同。

当前分支的生产 registry 为空；框架测试使用局部 registry。1.x baseline 和 2.0 表由后续独立工作加入。

## 4. 持久元数据

`schema_migrations` 是 Schema 版本的唯一权威来源：

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
) STRICT;
```

- `version` 同时记录 migration Schema 版本。
- `name` 记录 migration ID。
- `checksum` 使用小写十六进制 SHA-256。
- `applied_at` 是成功提交记录时的 Unix epoch milliseconds。
- `duration_ms` 是执行 `up` 的非负单调耗时，取整为毫秒。
- 不维护 `PRAGMA user_version` 或第二张 Schema 版本表，避免双权威漂移。

## 5. 校验与执行

bootstrap connection 打开后依次执行：

1. 创建 `schema_migrations` 元数据表。
2. 读取所有已应用记录并按 version 排序。
3. 若数据库最高 version 高于 registry 最高 version，抛出 `database_newer_than_program`。
4. 对每个已应用记录定位相同 version 的注册项；若不存在或 name 不同，抛出 `unknown_applied_migration`。
5. 重新计算已应用项 checksum；不一致时抛出 `checksum_mismatch`。
6. 按 registry 固定顺序执行未应用 migration。

每个 migration 使用一个 `BEGIN IMMEDIATE` 事务：先执行 `up`，再插入唯一的 migration 记录，最后提交。执行或记录失败时回滚当前事务。已提交的前序 migrations 保留，下次启动通过记录跳过它们并从失败项继续。

数据库中同一 migration 由主键、唯一 name、事务和 Instance Lock 共同保证只能成功应用一次。

## 6. 错误模型与连接生命周期

框架对外抛出类型化 `MigrationError`，至少包含：

- 稳定 `code`：`invalid_registry`、`database_newer_than_program`、`unknown_applied_migration`、`checksum_mismatch` 或 `migration_failed`。
- 可用时包含 `version` 和 `migrationName`。
- migration 执行失败时通过 `cause` 保留底层 SQLite/应用错误。

bootstrap helper 使用 `try/finally` 保证成功、校验失败和执行失败均关闭连接。关闭失败不得覆盖原始失败；两者同时失败时使用 `AggregateError`，原始错误排在首位。

## 7. 测试策略

测试使用真实临时 SQLite 数据库和真实 SQL，不 mock migration 行为：

- 空数据库：从零按固定顺序执行，记录完整元数据和最终版本。
- 重复运行：第二次不调用任何已应用 migration，记录数不变。
- 重复启动：bootstrap 使用两个独立的真实连接打开同一文件数据库，第二次不重复执行已记录 migration。
- 内存启动：daemon 和 bootstrap 在任何锁或 I/O 前以 `in_memory_database_unsupported` fail closed；`runMigrations()` 的真实内存数据库单测继续保留。
- checksum 漂移：改变已执行 migration 的 `source` 后拒绝启动。
- 未知新版本：数据库最高 version 高于当前 registry 时拒绝启动。
- 未知/改名 migration：数据库记录不能映射当前 registry 时拒绝启动。
- 中途失败：当前 migration 的 SQL 和记录均回滚，连接关闭，前序成功项保留；修复失败项后可从断点继续。
- 注册表验证：拒绝非递增 version、重复 version/name 和非法值。
- daemon 顺序：断言 Instance Lock 已持有后才迁移，迁移结束后才创建业务应用；迁移失败时不创建应用并释放锁。

最终验证运行 migration 定向测试、server 全量测试、typecheck 和 lint。
