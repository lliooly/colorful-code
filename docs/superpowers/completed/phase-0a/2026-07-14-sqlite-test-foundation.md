# Phase 0A SQLite Test Foundation 实现计划

> **进度：任务 1–7 的实现、全仓 Gate 与最终独立安全/规格审查均已完成；尚未暂存或提交，保留给人工复核。下方步骤复选框保留最初 TDD 执行计划，不作为当前状态源；实际状态以本段和最终验证记录为准。**
>
> 实现期间基于审查结果完成了额外安全收紧：迁移备份从启动期 `VACUUM INTO` 改为 512 MiB 上限的独立 connection serialization，并增加私有权限、fsync 发布、hardlink/inode 校验和 post-backup data-version guard；Instance Lock 增加独立 guard、文件身份验证、固定 `application_id` 和运行期健康检查。测试数据库 helper 已统一收口到 Test Database Factory；production build 会清理旧产物并扫描测试路径、测试命名 API 和公开 Provider override 泄漏。

| 工作项                         | 当前状态          | 主要证据                                                    |
| ------------------------------ | ----------------- | ----------------------------------------------------------- |
| SQLite Configuration           | 已实现并通过 Gate | `sqlite-configuration.test.ts`、`database-provider.test.ts` |
| Test Database Factory          | 已实现并通过 Gate | `test-database-factory.test.ts`、Store helper 边界测试      |
| 1.x Schema Baseline            | 已实现并通过 Gate | manifest/version-map/four fixture variants                  |
| Backup/Lock 安全收口           | 已实现并通过 Gate | symlink/hardlink/inode/permissions/drift tests              |
| 联合 Phase 0A lifecycle        | 已实现并通过 Gate | `phase-0a-sqlite-foundation.test.ts`、invariant manifest    |
| lint/typecheck/build/full test | 已通过            | 2026-07-14 根目录完整命令，全部退出码为 0                   |

最新验证记录：根目录 `pnpm lint`（11/11）、`pnpm typecheck`（16/16）、`pnpm build`（10/10）和 `pnpm test` 均成功；完整测试中服务端 34 个文件共 388 项、Web 45 项、CLI 5 项均为 0 失败。最后一个仅影响启动错误固定文案的防御补丁后，又完整复跑服务端 388/388，并重跑 server lint、typecheck 与根目录生产 build。最后一次沙箱外全仓复跑因工作区审批额度耗尽未获执行权限；其余 package 未被该补丁修改。完整测试中的既有 localhost 监听用例需要在允许绑定 `127.0.0.1` 的环境运行。所有本分支改动文件通过 Prettier 定向检查和 `git diff --check`；仓库级 `pnpm format` 仍报告 106 个本分支未修改的历史文件，未在本分支扩大范围自动改写。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。每项生产行为遵循 TDD；实现任务依次执行，避免多个代理同时修改共享数据库边界。

**目标：** 统一并验证所有 SQLite 连接配置，冻结真实 1.x Schema baseline，提供隔离且可故障注入的 Test Database Factory，并完成 Phase 0A 联合 Gate。

**架构：** 生产侧拆分为 SQLite policy/diagnostics/checkpoint、legacy baseline introspection、正式 baseline migration 三个小边界；DatabaseProvider 和 migration bootstrap 只组合这些边界，不再自行建表或散落 PRAGMA。测试侧用一个资源所有权明确的工厂组合真实 Instance Lock、backup、migration、Provider 和 Clock，最终用 invariant manifest 证明 Phase 0A 要求与测试一一对应。

**技术栈：** TypeScript、Bun 1.3.14、`bun:sqlite` / SQLite 3.54、Drizzle ORM、Node test API、Nest build、pnpm/Turbo。

---

## 文件结构

**生产文件**

- 创建 `apps/server/src/persistence/sqlite-configuration.ts`：连接角色、固定 PRAGMA、回读验证、结构化配置错误。
- 创建 `apps/server/src/persistence/sqlite-diagnostics.ts`：SQLite version/compile options/WAL/FK/backup/RETURNING 能力探测与安全序列化。
- 创建 `apps/server/src/persistence/sqlite-checkpoint.ts`：一次性、无循环的 PASSIVE checkpoint 与结构化结果。
- 创建 `apps/server/src/persistence/legacy-schema-baseline.ts`：canonical 1.x DDL、Schema introspection、canonical manifest/checksum、数据库分类。
- 创建 `apps/server/src/persistence/schema-manifest.ts`：结构化 introspection、canonical serializer 与 checksum。
- 创建 `apps/server/src/persistence/migration-baseline-adoption.ts`：unmanaged 1.x 的原子 metadata adoption 与事务内复验。
- 创建 `apps/server/src/persistence/migrations/0001-legacy-1x-baseline.ts`：不可变 migration 1。
- 修改 `apps/server/src/persistence/migration-framework.ts`：让 adoption 复用唯一 metadata DDL/record helper，不复制 migration metadata Schema。
- 修改 `apps/server/src/persistence/database.ts`：只保留 Drizzle adapter，删除配置和隐式建表旁路。
- 修改 `apps/server/src/persistence/schema.ts`：移除散落 `SCHEMA_DDL`，Drizzle table 定义保持不变。
- 修改 `apps/server/src/persistence/database-provider-internal.ts`：组合统一 policy/diagnostics/checkpoint，修复 transaction/close 竞态，限制 retry 总预算，支持只读模式。
- 修改 `apps/server/src/persistence/database-provider.ts`：导出稳定的 access mode、diagnostics、checkpoint 和错误类型。
- 修改 `apps/server/src/persistence/database-provider.testing.ts`：只暴露窄故障点，不进入生产导出。
- 修改 `apps/server/src/persistence/migration-bootstrap.ts`：配置 bootstrap connection、baseline preflight/adoption、正式 registry 和 post-migration checksum 验证。
- 修改 `apps/server/src/persistence/index.ts`：只导出生产 API，不导出测试 factory/raw access。

**Baseline 资产与工具**

- 修改 `apps/server/scripts/create-legacy-fixture.ts`：从 canonical baseline 创建确定性 normal/missing-optional/orphaned/WAL fixture。
- 修改 `apps/server/test/fixtures/legacy-v1/schema.sql`：与 canonical DDL 的非幂等可读形式保持机器一致。
- 创建 `apps/server/test/fixtures/legacy-v1/schema-manifest.json`：SQLite introspection 的冻结 manifest。
- 创建 `apps/server/test/fixtures/legacy-v1/version-map.json`：1.x application family、`user_version = 0` 与 migration version 1 的映射。

**测试 support**

- 创建 `apps/server/test/support/test-database-clock.ts`：可 set/advance 的固定 Clock。
- 创建 `apps/server/test/support/test-database-factory.ts`：隔离目录、真实 lifecycle、场景准备、故障注入、raw test callback 和聚合清理。
- 修改 `apps/server/test/support/test-session-store.ts`、`apps/server/test/support/test-plugin-store.ts`：改用统一工厂或统一已迁移 Provider helper。

**测试与 Gate**

- 创建 `apps/server/test/sqlite-configuration.test.ts`。
- 扩充 `apps/server/test/database-provider.test.ts`。
- 重写 `apps/server/test/legacy-baseline.test.ts`。
- 扩充 `apps/server/test/migration-framework.test.ts` 和 `apps/server/test/migration-backup-recovery.test.ts`。
- 创建 `apps/server/test/test-database-factory.test.ts`。
- 创建 `apps/server/test/phase-0a-gate.test.ts`。
- 创建 `apps/server/test/phase-0a-invariants.json`。
- 创建 `apps/server/scripts/verify-production-build.ts`：构建后测试能力泄漏扫描。
- 创建 `apps/server/tsconfig.test-support.json`：覆盖新测试基础设施的 Bun ESM typecheck。
- 修改 `apps/server/package.json`：clean build + 产物 verifier，并让 lint/typecheck 覆盖新测试基础设施。
- 修改 `apps/server/test/database-access-boundary.test.ts`：检查 PRAGMA 唯一入口、测试模块隔离和 production build 边界。

## 任务 1：统一 SQLite policy、diagnostics 与 checkpoint

**文件：**

- 创建：`apps/server/src/persistence/sqlite-configuration.ts`
- 创建：`apps/server/src/persistence/sqlite-diagnostics.ts`
- 创建：`apps/server/src/persistence/sqlite-checkpoint.ts`
- 创建：`apps/server/test/sqlite-configuration.test.ts`

- [ ] **步骤 1：先写连接角色和真实 PRAGMA 红灯测试**

测试用临时文件分别打开 read-write、migration-bootstrap 和 readonly connection，断言：

```ts
assert.equal(readPragma(raw, 'journal_mode'), 'wal');
assert.equal(readPragma(raw, 'foreign_keys'), 1);
assert.equal(readPragma(raw, 'synchronous'), 2);
assert.equal(readPragma(raw, 'temp_store'), 2);
assert.equal(readPragma(raw, 'trusted_schema'), 0);
assert.equal(readPragma(raw, 'busy_timeout'), 250);
```

readonly 连接额外断言 `query_only = 1`，并在非 WAL 文件上以稳定错误码失败。使用注入的 query/exec adapter 模拟 WAL 返回 `delete`、PRAGMA 不受支持和回读不一致。

- [ ] **步骤 2：运行目标测试确认因模块缺失而失败**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test ./test/sqlite-configuration.test.ts
```

预期：FAIL，找不到 `sqlite-configuration` 或导出符号；不能是测试语法错误。

- [ ] **步骤 3：实现最小 policy API**

实现固定角色和错误：

```ts
export type SqliteConnectionRole =
  | 'business-read-write'
  | 'business-read-only'
  | 'migration-bootstrap';

export class SqliteConfigurationError extends Error {
  readonly code:
    | 'pragma_failed'
    | 'pragma_mismatch'
    | 'wal_unavailable'
    | 'unsupported_runtime';
  readonly role: SqliteConnectionRole;
  readonly pragma?: string;
}

export function configureSqliteConnection(
  database: Database,
  role: SqliteConnectionRole,
): SqliteConnectionConfiguration;
```

所有值使用常量：业务 250ms、bootstrap 1000ms、`FULL`、`MEMORY`、`trusted_schema OFF`。设置后逐项查询验证；WAL 同时验证设置语句返回值和最终值。错误信息禁止拼接 filename。

- [ ] **步骤 4：写 diagnostics 红灯测试并实现能力探测**

测试 SQLite 版本、compile options 排序、FK/WAL、`RETURNING`（SQLite >= 3.35）、当前 `vacuum-into` 备份方法和敏感字符串过滤。实现：

```ts
export type SqliteDiagnostics = Readonly<{
  sqliteVersion: string;
  connectionRole: SqliteConnectionRole;
  journalMode: 'wal';
  foreignKeys: true;
  backupMethod: 'online-backup' | 'vacuum-into';
  returningSupport: boolean;
  compileOptions: readonly string[];
}>;
```

拒绝 `OMIT_FOREIGN_KEY`、`OMIT_TRIGGER` 和既无 Online Backup 也无 `VACUUM INTO` 的 runtime。不要执行会改变用户 Schema 的永久探针；`VACUUM INTO` 支持由 SQLite version/真实临时数据库测试证明。

- [ ] **步骤 5：写 checkpoint 红灯测试并实现一次 PASSIVE 调用**

覆盖 completed、incomplete、interrupted、SQLite throw；断言没有重试循环。实现：

```ts
export type WalCheckpointResult = Readonly<{
  status: 'completed' | 'incomplete' | 'interrupted';
  sqliteBusy: boolean;
  logFrames: number;
  checkpointedFrames: number;
  remainingFrames: number;
}>;
```

SQLite 标准返回第一列是 busy flag，不命名为“busy frames”。真实 reader transaction 测试必须覆盖 `busy = 0` 但 `checkpointed < log` 的 incomplete 结果；reader 结束后再次 checkpoint 才 completed。

- [ ] **步骤 6：运行目标测试、格式检查并提交**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/sqlite-configuration.test.ts
pnpm --filter @colorful-code/server typecheck
pnpm exec prettier --check apps/server/src/persistence/sqlite-*.ts apps/server/test/sqlite-configuration.test.ts
```

提交：`feat(持久化): 统一 SQLite 连接策略与诊断`

## 任务 2：接入 Provider，关闭竞态并限制 busy 总预算

**文件：**

- 修改：`apps/server/src/persistence/database-provider-internal.ts`
- 修改：`apps/server/src/persistence/database-provider.ts`
- 修改：`apps/server/src/persistence/database-provider.testing.ts`
- 修改：`apps/server/src/persistence/database.ts`
- 修改：`apps/server/test/database-provider.test.ts`

- [ ] **步骤 1：先写 Provider 配置、只读和 schema 旁路红灯测试**

断言每次新 Provider/restart 都获得相同 diagnostics；只读 Provider 可 `read()`、`transaction()` 抛 `DatabaseReadOnlyError`；Provider 不再调用 `initializeLegacySchema`，对未迁移空库明确失败而不是自动补表。

- [ ] **步骤 2：先写并发 transaction 红灯测试**

第一个 transaction 在 busy retry sleep 中挂起，第二个 transaction 必须立即抛 `NestedTransactionError`；调用 `close()` 后第一个 transaction 不得再次 BEGIN。测试使用可控 Promise gate，不使用固定 `setTimeout`。

- [ ] **步骤 3：先写 retry 总预算红灯测试**

验证：

```text
(maxRetries + 1) * 250 + sum(max backoff) <= 2000
```

刚好 2000ms 接受，超过 2000ms 在 BEGIN 和 callback 前拒绝。指数计算使用饱和算法，避免巨大 `maxRetries` 导致 `2 ** n` overflow 或 O(n) 验证 DoS；先用安全上界提前拒绝不合理次数。

- [ ] **步骤 4：接入 access mode、policy、diagnostics 与 transaction ownership**

Provider 新增只读 `accessMode` 和 `diagnostics`。`#transactionActive` 覆盖真实数据库 transaction 和 pending retry/sleep；nested 和 concurrent 都由同一状态拒绝。同步 COMMIT/ROLLBACK 后立即释放，不为了已完成结果的 Promise settlement microtask 继续占用连接。

测试 hooks 只允许注入 connection factory、sleep/random、checkpoint 和 close 等窄边界；生产 factory 固定使用 production policy，不能被调用方跳过安全配置。

- [ ] **步骤 5：实现 checkpoint + close 聚合语义**

读写关闭顺序：标记 closing → 等待 active operation lease 归零 → checkpoint → physical close → ownership release。只读连接在 drain 后跳过无法执行且没有必要的 checkpoint。callback/Clock 内调用 close 不得同步关闭当前连接，也不得等待自身造成死锁。checkpoint incomplete 是结构化结果，不是 close failure；checkpoint throw 时仍 close。只有 physical close 成功后释放 ownership。若 close 成功但 checkpoint 失败，Provider 关闭且 ownership 释放，然后抛 checkpoint error；多错误按发生顺序 Aggregate。路径准备、打开和 ownership 冲突错误必须 typed 且不泄漏目录或 URI。

- [ ] **步骤 6：删除 Provider 隐式 Schema 初始化**

`database.ts` 只保留 `createDrizzleDatabase()`。删除或收紧 `openDatabase()`、`configureDatabaseConnection()`、`initializeLegacySchema()`，所有生产 PRAGMA 只存在于 `sqlite-configuration.ts`。同步更新边界测试的 allowlist。

- [ ] **步骤 7：验证并提交**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/database-provider.test.ts ./test/sqlite-configuration.test.ts
pnpm --filter @colorful-code/server typecheck
pnpm --filter @colorful-code/server lint
```

提交：`feat(持久化): 收紧数据库连接与关闭生命周期`

## 任务 3：冻结 1.x manifest、checksum 与 fixture contract

**文件：**

- 创建：`apps/server/src/persistence/legacy-schema-baseline.ts`
- 修改：`apps/server/src/persistence/schema.ts`
- 修改：`apps/server/scripts/create-legacy-fixture.ts`
- 修改：`apps/server/test/fixtures/legacy-v1/schema.sql`
- 创建：`apps/server/test/fixtures/legacy-v1/schema-manifest.json`
- 创建：`apps/server/test/fixtures/legacy-v1/version-map.json`
- 重写：`apps/server/test/legacy-baseline.test.ts`

- [ ] **步骤 1：写 introspection 红灯测试**

用当前生产 DDL 创建真实数据库，断言 manifest 精确记录 6 张表的列/type/not-null/default/PK、显式索引、自动索引 origin、空 FK、空 trigger 和 `user_version = 0`。对表/索引创建顺序不同但逻辑相同的数据库，checksum 必须一致。

- [ ] **步骤 2：实现 canonical DDL 与 manifest**

`LEGACY_1X_SCHEMA_STATEMENTS` 是唯一 DDL 来源；`LEGACY_1X_SCHEMA_SOURCE` 是固定拼接文本。Manifest query 使用来自 `sqlite_schema` 的名字并做 SQL string literal escaping；所有数组稳定排序，canonical JSON 不包含路径、页布局或 WAL frame。

```ts
export function inspectLegacySchema(database: Database): LegacySchemaManifest;
export function legacySchemaChecksum(manifest: LegacySchemaManifest): string;
export const LEGACY_1X_SCHEMA_CHECKSUM: string;
```

- [ ] **步骤 3：生成并冻结 manifest/version map**

新增生成模式只覆盖明确输出文件且默认拒绝 overwrite。测试从 canonical DDL 重新生成并与 checked-in JSON deepEqual；checksum 常量与 JSON 匹配。version map 明确 1.x family → user version 0 → migration version 1，未知 app version 不参与 Schema 猜测。

- [ ] **步骤 4：扩展确定性 fixture**

normal fixture 包含 session、parent/child checkpoints、多条 audit、project、metadata、非敏感 plugin/model config。删除 Session 和 Project 语义由当前 1.x code 读取/操作测试验证。missing-optional、orphaned 和 corrupt 使用明确 variant；任何快照、路径、config 都通过敏感词与绝对用户路径扫描。

- [ ] **步骤 5：用逻辑 checksum 验证重复生成**

对每张表按稳定 key 读取 canonical rows，再与 manifest checksum 合成 fixture logical checksum。两次生成必须相同；禁止用 `.db` 文件 bytes checksum 作为确定性证明。

- [ ] **步骤 6：验证并提交**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/legacy-baseline.test.ts
pnpm --filter @colorful-code/server fixture:legacy -- --help
pnpm --filter @colorful-code/server typecheck
```

提交：`feat(持久化): 冻结 1.x Schema 与确定性基线`

## 任务 4：实现 baseline migration adoption 与安全恢复

**文件：**

- 创建：`apps/server/src/persistence/migrations/0001-legacy-1x-baseline.ts`
- 创建：`apps/server/src/persistence/migration-baseline-adoption.ts`
- 修改：`apps/server/src/persistence/migration-framework.ts`
- 修改：`apps/server/src/persistence/migration-bootstrap.ts`
- 修改：`apps/server/src/persistence/index.ts`
- 修改：`apps/server/test/migration-framework.test.ts`
- 修改：`apps/server/test/migration-backup-recovery.test.ts`
- 修改：`apps/server/test/database-kernel-lifecycle.test.ts`

- [ ] **步骤 1：写 empty/legacy/managed/newer/corrupt 分类红灯测试**

分别验证：empty 运行 migration 1；无 metadata 的匹配 1.x adoption；已有 migration 1 重启不重复；version 2 明确 `database_newer_than_program`；业务对象不匹配 frozen checksum 在备份和 mutation 前拒绝。

- [ ] **步骤 2：实现不可变 migration 1**

```ts
export const LEGACY_1X_BASELINE_MIGRATION: Migration = Object.freeze({
  version: 1,
  name: 'legacy_1x_baseline',
  source: LEGACY_1X_SCHEMA_SOURCE,
  up(database) {
    for (const statement of LEGACY_1X_SCHEMA_STATEMENTS)
      database.exec(statement);
  },
});
```

registry 冻结为 `[LEGACY_1X_BASELINE_MIGRATION]`。source/name/version 不在后续任务中修改。

- [ ] **步骤 3：实现原子 unmanaged adoption**

匹配的 1.x 库先创建 backup，再进入 `BEGIN IMMEDIATE`，重新检查 metadata 不存在且 legacy manifest/rows checksum 未变化；随后通过 migration-framework 导出的内部 helper 创建严格 metadata schema并直接插入 migration 1 记录，不能复制第二份 metadata DDL。不要执行 `IF NOT EXISTS` baseline DDL。完整 legacy + 空 metadata 只补 row；metadata-only crash state 才运行 migration 1。事务失败 rollback，第三方在 preflight 后修改 Schema 必须 fail closed。

- [ ] **步骤 4：配置 bootstrap connection 并做 preflight**

open 后立即应用 migration role policy 和 diagnostics，再 inspect。未管理数据库只允许 empty 或 checksum 精确匹配 1.x；不匹配错误不得包含路径。managed 数据库交给既有 migration history/checksum 校验。

- [ ] **步骤 5：实现 pre/post checksum 验证与恢复边界**

pending migration 前记录 legacy checksum；migration 后 `integrity_check`、`foreign_key_check`、legacy checksum 和当前 database schema checksum 全部验证。migration/up/post-verify 失败走现有 backup → close → quarantine → restore，仍返回 migration failure；preflight 不兼容且尚未 mutation 时不 quarantine。

- [ ] **步骤 6：构造真实未 checkpoint WAL 测试**

第二条连接提交后保持 WAL sidecar，证明 main-file-only copy 丢数据，而 `createMigrationBackup` + migration 保留数据。等待 WAL 状态使用 PRAGMA/文件状态条件，不使用任意 sleep。

- [ ] **步骤 7：验证并提交**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/migration-framework.test.ts ./test/migration-backup-recovery.test.ts ./test/database-kernel-lifecycle.test.ts
pnpm --filter @colorful-code/server typecheck
```

提交：`feat(持久化): 接入 1.x 基线迁移与识别`

## 任务 5：建立统一 Test Database Factory

**文件：**

- 创建：`apps/server/test/support/test-database-clock.ts`
- 创建：`apps/server/test/support/test-database-factory.ts`
- 创建：`apps/server/test/test-database-factory.test.ts`
- 修改：`apps/server/test/support/test-session-store.ts`
- 修改：`apps/server/test/support/test-plugin-store.ts`
- 修改：使用手工数据库初始化的 server tests

- [ ] **步骤 1：写隔离、并行和 Clock 红灯测试**

并行创建两个 factory，断言目录/DB/lock 均不同；固定 Clock 的 set/advance 值通过 transaction 写入。测试结束后两个目录都删除且 lock 可重新获取。

- [ ] **步骤 2：实现最小资源所有权模型**

```ts
export type TestDatabase = {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly provider: DatabaseProvider;
  readonly clock: TestDatabaseClock;
  close(): Promise<void>;
};
```

内部资源协调器按依赖关闭且 exactly-once：timer/busy/raw connection → Provider → Instance Lock → temp directory。Provider 物理关闭状态未知时不得继续 release lock/rm；synthetic cleanup fault 只在真实资源释放后抛出。主体错误永远是 AggregateError 第一项。`close()` 幂等并共享 Promise。目录只删除 factory 创建且 identity 未变化的路径，避免 symlink/path replacement 清理越界。

- [ ] **步骤 3：组合真实 lifecycle**

工厂准备离线 fixture 后，使用真实 `DataDirectoryInstanceLock.acquire`、`bootstrapMigrations`、`createDatabaseProvider` 和最小 lifecycle application。不要复制 daemon 启动顺序。Provider close 成功后才 release Instance Lock。

- [ ] **步骤 4：实现场景与故障点**

覆盖 empty、migrated、legacy-v1 variants、known schema version、corrupt migration、WAL uncheckpointed、busy lock、readonly。migration failure 指定 version；busy 使用真实第二 connection 的 `BEGIN IMMEDIATE` 和显式 release gate；清理取消所有 gate/timer。

- [ ] **步骤 5：实现显式 raw test callback**

```ts
export function withRawTestConnection<T>(
  database: TestDatabase,
  role: 'read-only' | 'lock-holder',
  operation: (connection: Database) => T,
): T;
```

只从 test support 导出；finally close；拒绝 Promise 返回和 callback 后使用。普通 TestDatabase 不保存 raw connection。

- [ ] **步骤 6：迁移旧 test helpers**

`test-session-store`、`test-plugin-store` 和重复 mkdtemp/provider 初始化改用 factory。只保留专门 SQLite 测试的 raw access。用结构测试拒绝新增手工初始化片段。

- [ ] **步骤 7：验证并提交**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/test-database-factory.test.ts ./test/session-store.test.ts ./test/plugins.test.ts
pnpm --filter @colorful-code/server typecheck
```

提交：`test(持久化): 建立统一测试数据库工厂`

## 任务 6：完成 Phase 0A 联合 Gate 与生产隔离

**文件：**

- 创建：`apps/server/test/phase-0a-gate.test.ts`
- 创建：`apps/server/test/phase-0a-invariants.json`
- 创建：`apps/server/scripts/verify-production-build.ts`
- 创建：`apps/server/tsconfig.test-support.json`
- 修改：`apps/server/package.json`
- 修改：`apps/server/test/database-access-boundary.test.ts`
- 修改：`apps/server/test/database-kernel-lifecycle.test.ts`
- 修改：`docs/superpowers/specs/2026-07-14-sqlite-test-foundation-design.md`

- [ ] **步骤 1：先写 invariant manifest 校验红灯测试**

manifest 使用数组项 `{id,evidence[]}`，解析后拒绝重复/未知 ID、路径逃逸、不存在测试文件、不存在或动态生成的完整测试名。用 TypeScript AST 读取顶层静态 `test('literal', ...)`，不用 substring/regex。manifest 覆盖设计中的 `P0A-LOCK-001` 到 `P0A-COMPAT-001`。

- [ ] **步骤 2：实现完整联合生命周期测试**

用 Test Factory 真实执行 1.x fixture → lock → backup → migration → Provider → PRAGMA → transaction/Clock → close/checkpoint → restart。覆盖 empty、normal 1.x、WAL、corrupt、newer、feature flag off。

- [ ] **步骤 3：补齐 FK 与 busy 副作用 Gate**

FK 测试使用专门测试 fixture 的真实 parent/child constraint，不修改 1.x baseline；非法写入必须在 transaction 内失败并 rollback。busy 测试证明 callback/constraint 最终只产生一次业务状态，并验证总 wall time 只作宽松上界辅助，主要断言注入 sleep/attempt 预算。

- [ ] **步骤 4：验证生产构建不含测试能力**

把现有 `database-provider.testing.ts` 与内部 test factory 从生产 `src` 移到 test support。新增可工作的 Bun ESM test-support tsconfig，并让 package lint/typecheck 覆盖工厂、Gate 与 verifier。production build 先清空 `dist`，Nest build 后执行 verifier，扫描 emitted JS/map，拒绝 `.testing`、`create*Test*`、`TestDatabaseProviderOptions`、fixture generator 或 `test/fixtures` 路径，避免旧产物和漏扫造成假通过。

- [ ] **步骤 5：运行 Phase 0A 目标 Gate**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/phase-0a-gate.test.ts ./test/database-access-boundary.test.ts ./test/database-kernel-lifecycle.test.ts
pnpm --filter @colorful-code/server build
```

- [ ] **步骤 6：提交主要 Gate 实现**

提交：`test(持久化): 建立 Phase 0A 完整验收门禁`

## 任务 7：完整验证、双阶段 review 与用户手动提交交接

**文件：**

- 可能修改：审查发现的生产、测试、规格或计划文件
- 不创建最终自动 commit

- [ ] **步骤 1：运行完整新鲜验证**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format
```

逐条读取完整输出和退出码；不能用目标测试代替全量 Gate。

- [ ] **步骤 2：规格合规审查**

独立 reviewer 对照用户三项任务、联合测试、Phase 0A Gate 和本设计逐条检查实际代码。任何缺失先修复并重跑相关测试。

- [ ] **步骤 3：代码质量与安全审查**

独立 reviewer 重点检查：

- transaction/close/lock release 竞态；
- retry overflow、双重等待和重复副作用；
- checkpoint busy/error 后的资源释放；
- migration preflight、backup、quarantine、restore 的 mutation 边界；
- raw test connection 逃逸、路径替换和清理越界；
- diagnostics/fixture/错误消息的敏感信息泄漏；
- WAL 与并行测试的 flaky 等待；
- production build 测试代码漂移。

Critical/Important 全部修复并重新审查。

- [ ] **步骤 4：完成 requirement-by-requirement audit**

从原始任务提取每个明确要求，记录证明文件、测试名和最新命令输出。证据缺失视为未完成，继续实现或测试。

- [ ] **步骤 5：保留最终 review 修正为未提交变更**

最后一轮 review 产生的修正、审计映射或文档更新不自动 commit。确认 `git diff --check`、目标测试和完整验证仍通过后，把工作区、提交列表、未提交 diff 摘要和 review 发现交给用户，由用户检查并手动提交。
