# Migration Bootstrap Connection + Migration Framework 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [x]`）语法跟踪进度。用户明确要求不提交，因此所有 Commit 步骤改为检查未提交 diff。

**目标：** 在 Instance Lock 与业务数据库连接之间建立最小权限、forward-only、可重复启动且能拒绝漂移/未来版本的持久化文件 SQLite migration bootstrap framework。

**架构：** 独立 migration 模块拥有 registry 校验、SHA-256 checksum、`schema_migrations` 元数据和逐 migration 事务；bootstrap helper 独占短生命周期 `bun:sqlite` connection，并只向 migration 暴露同步 `exec` facade。`startDaemon()` 在持有 data-directory Instance Lock 后运行 bootstrap，关闭连接后才创建 Nest application。daemon/bootstrap 只支持持久化文件数据库；内存数据库需要后续 `DatabaseProvider` 或 Test Database Factory 提供连接移交，但 `runMigrations()` 仍可直接使用真实内存 `Database` 做单元测试。

**技术栈：** TypeScript、Bun `bun:sqlite`、Node test runner via `bun test`、SHA-256 (`node:crypto`)

---

## 文件结构

- 创建 `apps/server/src/persistence/migration-framework.ts`：migration 类型、错误模型、registry/checksum 校验、元数据读取与逐项事务执行。
- 创建 `apps/server/src/persistence/migration-bootstrap.ts`：生产空 registry、文件目录准备、bootstrap connection 的打开/关闭与 cleanup error 聚合。
- 创建 `apps/server/test/migration-framework.test.ts`：真实 SQLite 覆盖空库、重跑、漂移、未来版本、未知记录、失败回滚/续跑、registry 校验和连接关闭。
- 修改 `apps/server/src/runtime/daemon-lifecycle.ts`：把 migration bootstrap 插入 Instance Lock 与业务应用创建之间。
- 修改 `apps/server/test/daemon-lifecycle.test.ts`：验证锁、migration、业务连接的严格顺序和 migration 失败清理。

### 任务 1：Migration registry、元数据与执行器

**文件：**

- 创建：`apps/server/src/persistence/migration-framework.ts`
- 创建：`apps/server/test/migration-framework.test.ts`

- [x] **步骤 1：写 registry 与 checksum 失败测试**

测试定义两个真实 migration，断言 checksum 是稳定的 64 位小写十六进制；分别传入 version 非正安全整数、非严格递增、重复 name 的 registry，断言 `MigrationError.code === 'invalid_registry'`。

```ts
const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'create_alpha',
    source: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY) STRICT;',
    up: (database) =>
      database.exec('CREATE TABLE alpha (id INTEGER PRIMARY KEY) STRICT;'),
  },
];
assert.match(computeMigrationChecksum(migrations[0]!), /^[a-f0-9]{64}$/);
assert.throws(
  () => validateMigrationRegistry([{ ...migrations[0]!, version: 0 }]),
  isMigrationError('invalid_registry'),
);
```

- [x] **步骤 2：运行定向测试，确认因模块/导出缺失而失败**

运行：`pnpm --filter @colorful-code/server exec bun test ./test/migration-framework.test.ts`

预期：FAIL，提示找不到 `migration-framework` 或所需导出。

- [x] **步骤 3：实现类型、错误、checksum 和 registry 验证的最少代码**

实现以下稳定接口：

```ts
export interface MigrationDatabase {
  exec(sql: string): void;
}
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly source: string;
  up(database: MigrationDatabase): void;
}
export type MigrationErrorCode =
  | 'invalid_registry'
  | 'database_newer_than_program'
  | 'unknown_applied_migration'
  | 'checksum_mismatch'
  | 'migration_failed';
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version?: number;
  readonly migrationName?: string;
}
export function computeMigrationChecksum(migration: Migration): string;
export function validateMigrationRegistry(
  migrations: readonly Migration[],
): void;
```

checksum 输入使用长度前缀字段，例如 `field.length + ':' + field`，避免简单字符串拼接歧义。registry 要求 version 为正安全整数、name 非空、source 非空、version 严格递增、name 唯一。

- [x] **步骤 4：运行定向测试确认 registry/checksum 通过**

运行：`pnpm --filter @colorful-code/server exec bun test ./test/migration-framework.test.ts`

预期：新增 registry/checksum 测试 PASS。

- [x] **步骤 5：写空库和重复运行失败测试**

使用临时文件和真实 `Database`。第一次执行两个 migration，断言业务表、version/name/checksum/applied_at/duration_ms；第二次用会计数的同一 registry 重跑，断言 `up` 调用数为 0 且 migration 记录仍为 2。

- [x] **步骤 6：运行测试确认 `runMigrations` 缺失而失败**

运行：同上。

预期：FAIL，提示 `runMigrations` 不存在或元数据表不存在。

- [x] **步骤 7：实现元数据表、已应用校验和逐 migration 原子事务**

实现：

```ts
export interface MigrationRunOptions {
  now?: () => number;
  monotonicNow?: () => number;
}
export function runMigrations(
  database: Database,
  migrations: readonly Migration[],
  options?: MigrationRunOptions,
): void;
```

执行器必须：

- 先验证 registry，再创建严格的 `schema_migrations` 表。
- 一次读取全部记录并按 version 排序。
- registry 为空时当前程序版本为 0。
- 先检查最高数据库版本，再核对每个已应用 version/name/checksum。
- 每个 pending migration 使用 `database.transaction(callback).immediate()`；在同一事务中执行 `up` 和参数化 `INSERT`。
- `up` 只收到冻结的 `{ exec }` facade，不收到原始 `Database`。
- `duration_ms = max(0, floor(end - start))`，`applied_at = floor(now())`。
- migration callback 或 INSERT 失败统一包装为带 version/name/cause 的 `migration_failed`。

- [x] **步骤 8：运行测试确认空库和重复运行通过**

运行：同上，预期全部现有测试 PASS。

- [x] **步骤 9：写 checksum 漂移、未来版本和未知/改名记录失败测试**

分别构造：已执行 migration 的 `source` 改变；手工插入比 registry 最大 version 更高的记录；手工插入 registry 中间不存在或 name 不匹配的记录。断言对应错误 code/version/name，且没有 pending migration 被执行。

- [x] **步骤 10：运行测试确认校验测试正确失败，再实现最少校验逻辑并转绿**

运行：同上。先观察每类错误因缺失校验而 FAIL，再补足步骤 7 中的预检顺序并重跑至 PASS。

- [x] **步骤 11：写中途失败、回滚和断点续跑失败测试**

第 1 项成功；第 2 项先建表再抛出 sentinel error；第 3 项会计数。断言第 2 项业务 DDL 和 migration 记录回滚、第 3 项未运行、第 1 项保留、错误 cause 原样保留。替换第 2 项为相同 version/name/source 的成功实现后重跑，断言只应用第 2、3 项。

- [x] **步骤 12：运行红灯，再完善事务错误包装直至全部通过**

运行：同上。预期最终 migration framework 定向测试 0 failure。

- [x] **步骤 13：检查未提交 diff（不 commit）**

运行：`git diff --check && git status --short`

预期：无 whitespace error；仅计划内文件为未提交变更。

### 任务 2：Bootstrap connection 与 daemon lifecycle 集成

**文件：**

- 创建：`apps/server/src/persistence/migration-bootstrap.ts`
- 修改：`apps/server/src/runtime/daemon-lifecycle.ts`
- 修改：`apps/server/test/migration-framework.test.ts`
- 修改：`apps/server/test/daemon-lifecycle.test.ts`

- [x] **步骤 1：写 bootstrap connection 成功/失败均关闭的失败测试**

通过注入 `openDatabase` 返回真实或受控 connection，分别让 `runMigrations` 成功和抛出 sentinel error；断言 `close(true)` 恰好一次。再让 migration 与 close 同时失败，断言 `AggregateError.errors` 顺序为 `[migrationError, closeError]`。

- [x] **步骤 2：运行定向测试确认 bootstrap helper 缺失而失败**

运行：`pnpm --filter @colorful-code/server exec bun test ./test/migration-framework.test.ts`

预期：FAIL，提示找不到 `migration-bootstrap` 或导出。

- [x] **步骤 3：实现最小 bootstrap helper 和生产空 registry**

稳定接口：

```ts
export const MIGRATIONS: readonly Migration[] = Object.freeze([]);
export interface MigrationBootstrapOptions {
  migrations?: readonly Migration[];
  openDatabase?: (path: string) => Database;
  runMigrations?: typeof runMigrations;
}
export function bootstrapMigrations(
  databasePath: string,
  options?: MigrationBootstrapOptions,
): void;
```

持久化文件路径先规范化，再执行 `mkdirSync(dirname(resolve(path)), { recursive: true })`。`''`、`:memory:`、`file::memory:` 和 `file::memory:?<query>` 在目录、连接和 migration 之前抛出 `in_memory_database_unsupported`；短生命周期 bootstrap connection 无法把内存库移交给业务应用，本任务不实现 keeper connection。connection 使用 `{ create: true, readwrite: true }`。显式捕获主失败和 close 失败，避免 `finally` 覆盖原错误。

- [x] **步骤 4：运行定向测试确认连接生命周期通过**

运行同上，预期全部 PASS。

- [x] **步骤 5：写 daemon 严格顺序和 migration 失败 cleanup 测试**

扩展 `StartDaemonOptions` 注入 `migrateDatabase`。成功事件必须严格等于：

```ts
['acquire-lock', 'migrate', 'create-app', 'register-close', 'listen'];
```

在 `migrate` 内断言 lock 已持有且 app 尚未创建。失败时断言 `createApplication`/`listen` 均为 0、lock release 为 1、抛出的 migration error identity 不变。migration 与 release 同时失败时断言 AggregateError 顺序正确。另对全部内存 sentinel 断言在获取锁和执行 I/O 前以 `in_memory_database_unsupported` fail closed。

- [x] **步骤 6：运行 daemon 定向测试观察正确红灯**

运行：`pnpm --filter @colorful-code/server exec bun test ./test/daemon-lifecycle.test.ts`

预期：FAIL，因为 lifecycle 尚未调用 migration。

- [x] **步骤 7：把 bootstrap migration 接入锁与业务连接之间**

`StartDaemonOptions` 增加可选同步或 Promise-compatible migration dependency：

```ts
migrateDatabase?: (databasePath: string) => void | Promise<void>;
```

默认使用 `bootstrapMigrations`。持久化文件路径解析成功并获取 lock 后，执行 `await migrateDatabase(resolvedDatabasePath)`，只在成功后以同一路径调用 `createApplication`。内存路径在获取 lock 前拒绝。复用现有 startup cleanup 聚合逻辑，不能增加第二套 lock release 路径。

- [x] **步骤 8：运行 daemon 与 main bootstrap 定向测试至通过**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test ./test/daemon-lifecycle.test.ts
pnpm --filter @colorful-code/server exec bun test ./test/main-bootstrap.test.ts
```

预期：0 failure。

- [x] **步骤 9：检查未提交 diff（不 commit）**

运行：`git diff --check && git status --short`

预期：无 whitespace error，不存在范围外生产改动。

### 任务 3：审查、竞态审计与全量验证

**文件：**

- 可能修改：上述实现和测试文件（仅修复审查发现的问题）

- [x] **步骤 1：规格合规审查**

逐条对照书面规格与用户要求，重点确认：业务连接绝不早于 migration；checksum 校验发生在任何 pending execution 前；未知高版本优先拒绝；失败项事务完整回滚；连接总能关闭。

- [x] **步骤 2：代码质量和锁/竞态审查**

独立审查以下风险：Instance Lock acquisition/release 单一所有权；migration 与 cleanup 多错误保真；重复启动与唯一约束；同步 transaction callback 不泄露 Promise；内存路径在锁和 I/O 前 fail closed；时间函数异常值；SQLite statement/connection 生命周期。

- [x] **步骤 3：修复所有 Critical/Important 问题并重新审查**

每个修复先增加能复现问题的失败测试，再做最小修改，重跑定向测试。直至规格和质量审查均通过。

- [x] **步骤 4：运行最终验证**

```bash
pnpm --filter @colorful-code/server exec bun test ./test/migration-framework.test.ts ./test/daemon-lifecycle.test.ts ./test/main-bootstrap.test.ts
pnpm --filter @colorful-code/server test
pnpm --filter @colorful-code/server typecheck
pnpm --filter @colorful-code/server lint
git diff --check
git status --short --branch
```

预期：所有命令 exit 0；无测试失败、类型错误、lint warning 或 whitespace error；分支为 `feat/v2-p0a-migration-framework`；无 commit。

- [x] **步骤 5：逐项完成审计**

将用户的 12 项范围要求和 5 项测试要求逐条映射到实现行与通过的测试，确认未引入 DatabaseProvider、Repository、2.0 表、Legacy Importer 或备份恢复逻辑。
