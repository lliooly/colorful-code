# Migration Backup & Recovery 设计

> **状态：已批准实施**

本文档细化 Colorful Code 2.0 Phase 0A 的第三项：在执行 forward-only SQLite migration 前创建一致性备份，并在 migration 失败时隔离失败数据库、原子恢复升级前状态，最后仍以 migration failure 退出。

## 1. 范围

本项实现：

- migration 开始前创建包含 WAL 已提交数据的一致性 SQLite 备份；
- 为每次备份生成唯一目录和 manifest，不覆盖历史备份；
- 在备份、迁移后数据库和恢复后数据库上执行 `integrity_check` 与 `foreign_key_check`；
- migration 或迁移后检查失败时先关闭 bootstrap connection，再隔离失败数据库；
- 校验备份 manifest 和 checksum 后，从升级前备份原子恢复；
- 恢复成功后仍抛出 migration failure，阻止业务应用启动；
- 清理未完成的临时备份和临时恢复文件；
- 用真实 SQLite 文件和故障注入覆盖 WAL、迁移中断、恢复失败、损坏备份和重复恢复。

本项不实现：

- `DatabaseProvider`、连接池或业务连接所有权；
- 通用 Transaction API；
- Colorful Code 2.0 业务 Schema；
- 历史备份或 quarantine 自动删除；
- Legacy Importer；
- down migration 或数据库降级。

## 2. 组件边界

新增 `migration-backup-recovery.ts`，封装备份、manifest、数据库检查、失败库隔离和恢复。它只接收文件路径、migration 版本信息和少量可注入的文件系统/SQLite 操作，不拥有业务连接。

`migration-bootstrap.ts` 仍是启动编排器，顺序为：

```text
resolve database path
-> create data directory
-> open bootstrap connection
-> discover source schema version and target version
-> create and verify consistent backup
-> run migrations
-> verify migrated database
-> close bootstrap connection
-> return success
```

失败顺序为：

```text
capture migration failure
-> close bootstrap connection
-> quarantine failed database and SQLite sidecars
-> restore verified backup to a temporary SQLite database
-> atomically publish restored database without replacing the original path
-> verify restored database
-> throw migration failure even when recovery succeeded
```

`migration-framework.ts` 继续只负责 registry 校验和 migration 事务，不承担文件备份或恢复。

## 3. 一致性备份与 manifest

自动备份目录固定为源数据库同级的 `backups/`。每个正式备份使用 `<UTC compact timestamp>-<UUID>` 目录；构建时使用 `.<id>.tmp` 目录，完成后以同文件系统 rename 原子发布。任何目标已存在都拒绝覆盖。

所有自动迁移 writer 都必须在 Instance Lock 保护下调用 `createMigrationBackup()`，并通过同级隐藏 reservation 文件排他取得固定 UUID 名称的发布权。reservation 是协作式 no-replace 协议：清理时必须核对打开文件的 `dev` 与 `ino`，路径已不存在或已被替换时不得删除。底层 rename 不承诺 no-replace；非协作或恶意的文件系统修改不在当前信任边界内。该方案只依赖跨平台文件 API，不引入平台专用 FFI。

快照使用同一个 bootstrap connection 执行 `VACUUM INTO`。SQLite 会从当前逻辑数据库生成独立、完整的数据库文件，因此 WAL 中已提交但尚未 checkpoint 的数据会进入快照；禁止复制正在使用的主数据库文件。

manifest 使用格式版本 `1`，记录：

- `sourceDatabasePath`：源数据库绝对路径；
- `sourceSchemaVersion`：迁移前 `schema_migrations` 最大版本，不存在时为 `0`；
- `targetSchemaVersion`：registry 的最高版本，不存在时为 `0`；
- `createdAt`：ISO 8601 UTC 时间；
- `databaseFile`：备份数据库文件名；
- `sizeBytes`：备份文件大小；
- `sha256`：备份数据库 SHA-256；
- `integrityCheck`：必须为 `ok`；
- `foreignKeyViolations`：必须为 `0`。

备份文件和 manifest 都以排他创建语义写入。备份验证或发布失败时删除临时目录，不留下看似可用的正式备份。

## 4. 完整性检查

`verifyDatabase()` 对独立 SQLite connection 执行完整 `PRAGMA integrity_check` 并读取全部结果；只有单行 `ok` 算成功。随后执行 `PRAGMA foreign_key_check`，任何结果行都算失败。

检查发生在 3 个位置：

1. 备份快照创建后、manifest 发布前；
2. migration 全部执行后、bootstrap connection 关闭前；
3. 恢复文件原子发布后。

检查错误进入 migration failure/recovery failure 闭环，不能让应用继续启动。

## 5. 隔离与原子恢复

失败后必须先完成 bootstrap connection 的强制关闭。关闭失败也不能跳过恢复尝试；最终通过 `AggregateError` 保留原始 migration/check 错误、close 错误和 recovery 错误的顺序。

隔离目录位于数据库同级的 `migration-quarantine/<UTC compact timestamp>-<UUID>/`。关闭连接后，将主数据库以及存在的 `-wal`、`-shm` sidecar 移入该目录。只有原路径不再存在，才允许开始恢复。quarantine 不自动删除。

恢复首先读取并严格校验 manifest：字段集合、绝对源路径、版本字段、文件名、大小和 SHA-256 必须匹配。然后以只读方式打开备份，在源数据库同目录排他创建唯一 `.restore-<UUID>.tmp/` staging 目录并记录目录身份，通过 `VACUUM INTO` 在其中生成恢复数据库并执行完整性检查。发布前若原数据库、`-wal` 或 `-shm` 任一目录项（包括 dangling symlink）已存在，恢复明确拒绝覆盖；因此重复恢复不会覆盖已恢复或新建的业务数据库。

staging 中的恢复文件通过同文件系统 hard link 排他创建原路径，目标已存在时由文件系统原子拒绝，成功后删除 staging link。发布边界前后均检查 WAL/SHM，不允许 sidecar 混入恢复数据库。清理 staging 时必须核对目录的 `dev` 与 `ino`，不得删除被替换的路径。发布后再次从原路径打开只读 connection 做完整检查。若恢复失败，原路径必须保持不存在；若失败发生在发布后的 sidecar 检查或最终完整性检查，已发布文件会重新移入同一 quarantine，避免损坏数据库被业务启动使用。

数据库 checksum 使用固定大小 buffer 增量读取和 SHA-256 更新，不把整个数据库一次性载入内存。

## 6. 错误状态

新增结构化错误类型区分：

- `backup_failed`：备份创建、验证或发布失败，migration 未开始；
- `migration_failed_recovered`：migration/检查失败且恢复成功；
- `migration_failed_recovery_failed`：migration/检查失败且恢复失败；
- `recovery_refused`：恢复目标已经存在，拒绝重复覆盖；
- `backup_invalid`：manifest、checksum 或备份 SQLite 检查不通过。

备份失败直接关闭 connection 并退出，不隔离尚未执行 migration 的源库。migration 已开始后无论恢复是否成功都以失败状态退出。daemon lifecycle 因此不会创建业务应用，并照常释放 Instance Lock。

## 7. 测试策略

测试使用真实临时目录和 `bun:sqlite`：

- WAL 模式下保持 writer connection 打开且不手动 checkpoint，确认快照含最新提交；
- migration 在已提交的前置 migration 之后失败，确认源库被隔离并恢复到 migration 前版本；
- 注入恢复生成、排他发布或最终检查失败，确认原路径不可作为业务库；
- 篡改备份字节或 manifest checksum，确认恢复拒绝损坏备份；
- 对已经存在的恢复目标重复恢复，确认不会覆盖；
- 断言成功与失败路径均无 `.tmp` 备份目录或 `.restore-*.tmp` 文件；
- 断言恢复成功仍向 daemon 抛错，业务应用不会创建；
- 保留 migration framework、daemon lifecycle 和 server 全量回归测试。

## 8. 非目标确认

实现不得新增业务连接抽象、通用事务回调、2.0 业务表、备份 retention、legacy 数据读取或 down migration。恢复功能仅服务当前进程刚刚失败的 forward migration。
