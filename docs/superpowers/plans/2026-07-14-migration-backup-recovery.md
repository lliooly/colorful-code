# Migration Backup & Recovery 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 在 SQLite migration 前创建已验证的一致性备份，并在 migration 失败后关闭连接、隔离失败库、原子恢复升级前状态，最终仍以明确失败退出。

**架构：** 新增一个不拥有业务连接的备份恢复模块，封装 `VACUUM INTO`、manifest、checksum、完整性检查、quarantine 和原子发布。`bootstrapMigrations()` 只编排 connection 生命周期以及成功/失败顺序，现有 migration executor 保持不变。

**技术栈：** TypeScript、Bun、`bun:sqlite`、Node.js 文件系统 API、`node:test`、SHA-256。

---

## 文件结构

- 创建 `apps/server/src/persistence/migration-backup-recovery.ts`：一致性备份、manifest 校验、数据库检查、失败库隔离和原子恢复。
- 创建 `apps/server/test/migration-backup-recovery.test.ts`：用真实 SQLite 文件验证备份/恢复原语与损坏输入。
- 修改 `apps/server/src/persistence/migration-bootstrap.ts`：编排备份、migration、迁移后检查、关闭、隔离和恢复。
- 修改 `apps/server/test/migration-framework.test.ts`：验证 bootstrap 的完整失败恢复闭环和错误聚合。
- 修改 `apps/server/src/persistence/index.ts`：导出稳定的备份恢复类型与函数。

### 任务 1：一致性备份与 manifest

**文件：**

- 创建：`apps/server/src/persistence/migration-backup-recovery.ts`
- 创建：`apps/server/test/migration-backup-recovery.test.ts`

- [ ] **步骤 1：编写 WAL 一致性备份失败测试**

测试创建 WAL 数据库并保持 writer connection 打开，插入最新提交后调用尚不存在的 `createMigrationBackup()`。断言备份可读取最新行、manifest 包含源路径、源版本、目标版本、创建时间和 SHA-256，并且正式目录唯一。

- [ ] **步骤 2：运行测试验证红灯**

运行：`pnpm --filter @colorful-code/server exec bun test test/migration-backup-recovery.test.ts`

预期：FAIL，模块或 `createMigrationBackup` 尚不存在。

- [ ] **步骤 3：实现最小备份与检查逻辑**

实现以下公开边界：

```ts
export interface MigrationBackupManifest {
  readonly formatVersion: 1;
  readonly sourceDatabasePath: string;
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly createdAt: string;
  readonly databaseFile: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly integrityCheck: 'ok';
  readonly foreignKeyViolations: 0;
}

export interface MigrationBackup {
  readonly directoryPath: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly manifest: MigrationBackupManifest;
}

export function verifyDatabase(databasePath: string): void;

export function createMigrationBackup(options: {
  database: Database;
  sourceDatabasePath: string;
  sourceSchemaVersion: number;
  targetSchemaVersion: number;
  now?: () => Date;
  randomId?: () => string;
}): MigrationBackup;
```

使用 `VACUUM INTO` 写入 `backups/.<id>.tmp/`，验证备份后写入 manifest，再 rename 到 `backups/<id>/`。所有失败路径递归删除临时目录。

- [ ] **步骤 4：运行测试验证绿灯**

运行同一步骤 2，预期新增测试全部 PASS。

- [ ] **步骤 5：补充损坏快照与临时目录清理测试**

注入非法 SQLite 源或目标冲突，断言未发布正式备份且没有 `.<id>.tmp` 残留。先观察测试失败，再补最小错误处理并重新验证。

- [ ] **步骤 6：阶段性提交**

```bash
git add apps/server/src/persistence/migration-backup-recovery.ts apps/server/test/migration-backup-recovery.test.ts
git commit -m "feat: add verified migration backups"
```

### 任务 2：隔离、manifest 校验与原子恢复

**文件：**

- 修改：`apps/server/src/persistence/migration-backup-recovery.ts`
- 修改：`apps/server/test/migration-backup-recovery.test.ts`

- [ ] **步骤 1：编写失败库隔离与恢复测试**

创建带 WAL/SHM sidecar 的失败数据库，调用尚不存在的 `quarantineDatabase()`，断言原路径和 sidecar 消失、quarantine 保留。随后调用 `restoreMigrationBackup()`，断言原路径恢复升级前内容并通过完整检查。

- [ ] **步骤 2：运行测试验证红灯**

运行目标测试文件，预期因隔离/恢复 API 缺失而 FAIL。

- [ ] **步骤 3：实现最小隔离和恢复 API**

实现以下边界：

```ts
export interface QuarantinedDatabase {
  readonly directoryPath: string;
  readonly databasePath?: string;
  readonly walPath?: string;
  readonly shmPath?: string;
}

export function quarantineDatabase(options: {
  databasePath: string;
  now?: () => Date;
  randomId?: () => string;
}): QuarantinedDatabase;

export function restoreMigrationBackup(options: {
  backup: MigrationBackup;
  targetDatabasePath: string;
  quarantine?: QuarantinedDatabase;
  randomId?: () => string;
}): void;
```

恢复必须重新读取 manifest、验证源路径/字段/大小/SHA-256，以只读 backup connection 执行 `VACUUM INTO` 到目标同目录临时文件，验证后 rename 发布，再验证正式路径。

- [ ] **步骤 4：运行测试验证绿灯**

运行目标测试文件，预期全部 PASS。

- [ ] **步骤 5：编写损坏备份、恢复失败和重复恢复测试**

分别篡改数据库字节、篡改 manifest checksum、注入 `VACUUM INTO`/rename 后检查失败，并在目标已存在时重复调用恢复。断言损坏备份拒绝恢复、失败目标被重新隔离、目标存在时不覆盖、临时文件全部清理。

- [ ] **步骤 6：实现结构化错误并验证绿灯**

错误类型至少区分 `backup_invalid`、`recovery_refused` 和恢复 I/O/SQLite 失败；重新运行目标测试。

- [ ] **步骤 7：阶段性提交**

```bash
git add apps/server/src/persistence/migration-backup-recovery.ts apps/server/test/migration-backup-recovery.test.ts
git commit -m "feat: add atomic migration recovery"
```

### 任务 3：接入 migration bootstrap

**文件：**

- 修改：`apps/server/src/persistence/migration-bootstrap.ts`
- 修改：`apps/server/test/migration-framework.test.ts`
- 修改：`apps/server/src/persistence/index.ts`

- [ ] **步骤 1：编写 migration 中途失败恢复测试**

在真实文件数据库中先写入旧数据，migration 1 成功修改，migration 2 抛错。调用 `bootstrapMigrations()` 后断言：connection 已关闭、失败数据库已进入 quarantine、原路径恢复旧数据、`schema_migrations` 不含本次升级结果，并且 Promise 仍以 `migration_failed_recovered` 拒绝。

- [ ] **步骤 2：运行测试验证红灯**

运行：`pnpm --filter @colorful-code/server exec bun test test/migration-framework.test.ts`

预期：FAIL，当前 bootstrap 只关闭连接并直接抛出原错误。

- [ ] **步骤 3：实现成功路径编排**

在 migration 前读取 Schema 版本、从 registry 读取目标版本、创建备份；migration 后调用完整检查；无论成功或失败都只关闭 bootstrap connection 一次。

- [ ] **步骤 4：实现失败恢复编排**

migration 开始后失败时：保存原错误、关闭 connection、隔离数据库、恢复备份并最终抛出 `MigrationRecoveryError`。恢复成功使用 `migration_failed_recovered`；恢复失败使用 `migration_failed_recovery_failed` 并保留原始错误顺序。备份创建失败使用 `backup_failed`，不隔离未迁移源库。

- [ ] **步骤 5：运行测试验证绿灯**

运行 migration framework 测试，预期全部 PASS。

- [ ] **步骤 6：补充恢复失败、close 失败和 daemon 不启动测试**

使用依赖注入稳定触发 close 与 restore 失败，验证错误身份/顺序；验证恢复成功仍拒绝启动业务应用。先观察每个新测试正确失败，再补最小实现。

- [ ] **步骤 7：导出公开类型并阶段性提交**

```bash
git add apps/server/src/persistence/migration-bootstrap.ts apps/server/src/persistence/index.ts apps/server/test/migration-framework.test.ts apps/server/test/daemon-lifecycle.test.ts
git commit -m "feat: recover failed database migrations"
```

### 任务 4：回归验证与最终 review

**文件：**

- 修改：仅限 review 发现的必要实现或测试文件

- [ ] **步骤 1：运行格式、类型和目标测试**

```bash
pnpm prettier --check apps/server/src/persistence apps/server/test/migration-backup-recovery.test.ts apps/server/test/migration-framework.test.ts docs/superpowers/specs/2026-07-14-migration-backup-recovery-design.md docs/superpowers/plans/2026-07-14-migration-backup-recovery.md
pnpm --filter @colorful-code/server typecheck
pnpm --filter @colorful-code/server exec bun test test/migration-backup-recovery.test.ts test/migration-framework.test.ts test/daemon-lifecycle.test.ts
```

- [ ] **步骤 2：运行 server 全量测试**

运行：`pnpm --filter @colorful-code/server test`

预期：0 fail。

- [ ] **步骤 3：规格符合性与代码质量审查**

逐条对照设计第 1、3、4、5、6、7、8 节；检查每项均有直接实现和测试证据。先修复 Critical/Important，再重复目标测试和全量测试。

- [ ] **步骤 4：主代理最终自审**

主代理亲自阅读 `git diff main...HEAD` 和未提交 diff，重点检查：连接关闭发生在文件操作前、原路径失效不变量、WAL/SHM 处理、manifest 信任边界、rename 原子性、恢复成功仍失败退出、临时文件清理以及范围外功能未引入。

- [ ] **步骤 5：保留最终 review 改动未提交**

不提交主代理最终 review 阶段产生的最后一批必要改动；保持在工作树中交由用户 review，报告已提交阶段点与未提交文件。
