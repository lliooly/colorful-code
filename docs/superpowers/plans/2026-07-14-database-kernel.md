# Phase 0A Database Kernel 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立单一业务数据库所有者、同步纯数据库 transaction callback 和数据库 UTC 毫秒 Clock，并把 daemon 与现有 1.x store 全部接入该内核。

**架构：** daemon 生命周期协调器在 Instance Lock 和 migration 完成后创建单连接 `DatabaseProvider`，把 Provider 注入 Nest，关闭时先关闭应用与 Provider，最后释放锁。Provider 用可失效的 Drizzle facade 执行 read 和显式事务，用当前 SQLite 连接读取每事务唯一时间，并只对完整的 `SQLITE_BUSY/LOCKED` 事务尝试做有界重试。

**技术栈：** TypeScript、Bun、`bun:sqlite`、Drizzle ORM、NestJS、`node:test`、ESLint、pnpm。

---

## 文件结构

- 创建 `apps/server/src/persistence/database-clock.ts`：Clock 类型、SQLite UTC 毫秒实现和固定测试实现。
- 创建 `apps/server/src/persistence/database-provider.ts`：Provider 状态、连接所有权、read、transaction、retry、错误与测试 factory。
- 创建 `apps/server/src/persistence/database-provider.module.ts`：把 daemon 已创建的 Provider 作为全局 Nest provider 注入。
- 创建 `apps/server/test/database-provider.test.ts`：Provider、transaction、Clock 和故障注入单元测试。
- 创建 `apps/server/test/database-kernel-lifecycle.test.ts`：Lock、migration、Provider、transaction、Clock、close 和 restart 联合测试。
- 创建 `apps/server/test/database-access-boundary.test.ts`：业务源码结构门禁。
- 修改 `apps/server/src/persistence/database.ts`：只保留数据库/Drizzle 类型与 legacy schema 初始化 helper，删除生产业务 open 入口。
- 修改 `apps/server/src/persistence/index.ts`：导出正式 Provider、Clock 与 Nest token。
- 修改 `apps/server/src/persistence/persistence.module.ts`：`SessionStore` 只依赖全局 Provider。
- 修改 `apps/server/src/persistence/session-store.ts`：所有 read 走 Provider，所有 write 走 transaction，持久化生成时间使用 `tx.now`。
- 修改 `apps/server/src/plugins/plugin-store.ts`：所有 read/write 走同一 Provider，移除独立连接生命周期。
- 修改 `apps/server/src/plugins/plugins.service.ts`、`apps/server/src/plugins/plugins.controller.ts`：等待异步 store 写入。
- 修改 `apps/server/src/sessions/sessions.service.ts`、`apps/server/src/sessions/projects.controller.ts`：等待异步 store 写入并保持原有 HTTP 语义。
- 修改 `apps/server/src/runtime/daemon-lifecycle.ts`：在 migration 后创建 Provider，统一 Provider/Lock 逆序清理。
- 修改 `apps/server/src/main.ts`、`apps/server/src/app.module.ts`：把 daemon 创建的 Provider 注入 Nest。
- 修改相关 1.x 测试：使用受控 test Provider，并等待异步写入。

### 任务 1：Database Clock 与 Provider 所有权

**文件：**

- 创建：`apps/server/src/persistence/database-clock.ts`
- 创建：`apps/server/src/persistence/database-provider.ts`
- 创建：`apps/server/test/database-provider.test.ts`
- 修改：`apps/server/src/persistence/database.ts`
- 修改：`apps/server/src/persistence/index.ts`

- [ ] **步骤 1：编写 Provider 所有权和 Clock 失败测试**

测试使用真实临时文件，覆盖：初始化后可 read；关闭后 read/Clock 拒绝；重复关闭只关闭一次；同目录第二个 Provider 被拒绝；不同目录可同时打开；初始化 pragma 或 schema 失败会关闭连接并释放目录注册；SQLite Clock 返回安全 UTC Unix 毫秒整数；固定 Clock 精确返回注入值；回拨值不被强制改成单调值。

```ts
const provider = createTestDatabaseProvider(databasePath, {
  clock: new FixedDatabaseClock(1_700_000_000_123),
});
assert.equal(
  provider.read((connection) => provider.clock.now(connection)),
  1_700_000_000_123,
);
await provider.close();
assert.throws(() => provider.read(() => undefined), ProviderClosedError);
```

- [ ] **步骤 2：运行测试确认正确失败**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/database-provider.test.ts
```

预期：FAIL，提示 `database-provider` 或 `database-clock` 模块不存在。

- [ ] **步骤 3：实现最小 Provider 状态、所有权和 Clock**

实现 `open → closing → closed` 单向状态、规范化目录注册表、统一 PRAGMA、legacy schema 初始化和幂等 close。初始化失败时先关闭已打开连接，再释放目录注册；两者都失败时保留初始化错误为首项。

Clock 通过当前连接执行等价于以下 SQL 的整数查询：

```sql
SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000
     + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER) AS now_ms;
```

`FixedDatabaseClock` 拒绝非安全整数，但不改变相邻调用的大小关系。

- [ ] **步骤 4：运行测试确认通过并检查格式**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/database-provider.test.ts
pnpm prettier --check apps/server/src/persistence/database-clock.ts apps/server/src/persistence/database-provider.ts apps/server/test/database-provider.test.ts
```

预期：Provider/Clock 测试 PASS，Prettier 无差异。

- [ ] **步骤 5：提交**

```bash
git add apps/server/src/persistence/database.ts apps/server/src/persistence/database-clock.ts apps/server/src/persistence/database-provider.ts apps/server/src/persistence/index.ts apps/server/test/database-provider.test.ts
git commit -m "feat(持久化): 建立数据库连接所有者与统一时钟"
```

### 任务 2：Transaction API、错误保真与 busy retry

**文件：**

- 修改：`apps/server/src/persistence/database-provider.ts`
- 修改：`apps/server/test/database-provider.test.ts`

- [ ] **步骤 1：逐组编写 transaction 失败测试**

使用真实 SQLite constraint 和可注入 driver fault 覆盖：成功 commit；callback 抛错 rollback；constraint violation 不留下前半段写入；commit 失败不成功返回；rollback 失败产生 `AggregateError([original, rollback])`；嵌套 transaction 拒绝；thenable/Promise 返回回滚；callback 结束后连接 facade 失效；同一 transaction 只能取得一次 Clock。

```ts
await assert.rejects(
  provider.transaction((tx) => {
    tx.database.db.insert(testRows).values({ id: 'partial' }).run();
    throw sentinel;
  }),
  (error) => error === sentinel,
);
assert.equal(
  provider.read((db) => countRows(db)),
  0,
);
```

- [ ] **步骤 2：运行测试确认行为缺失而失败**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/database-provider.test.ts
```

预期：新增 transaction 测试 FAIL，错误指向未实现的方法或不符合 rollback/失效语义。

- [ ] **步骤 3：实现显式事务状态机**

每次尝试按以下固定顺序执行，并在 `finally` 中 revoke facade：

```ts
connection.exec('BEGIN IMMEDIATE');
const now = clock.now(scopedConnection);
const result = operation(
  Object.freeze({ database: scopedConnection, clock, now }),
);
if (isThenable(result)) throw new AsyncTransactionCallbackError();
connection.exec('COMMIT');
return result;
```

失败且事务已开始时执行 `ROLLBACK`。嵌套标记按 Provider 实例维护，仅在 callback 活跃期间为 true。

- [ ] **步骤 4：编写 busy retry 和生命周期失败测试**

注入确定性 fault 与等待器，验证：只有 `SQLITE_BUSY/LOCKED` 重试；每次重新 BEGIN、Clock 和 callback；达到上限抛最后错误；退避参数正确；默认不重试；外部准备函数只在调用 transaction 前执行一次；等待期间 close 后不开始下一次事务。

```ts
const prepared = prepareOutsideDatabase();
await provider.transaction((tx) => insertPrepared(tx, prepared), {
  retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 },
});
assert.equal(prepareCalls, 1);
assert.equal(transactionAttempts, 3);
```

- [ ] **步骤 5：实现可配置完整事务重试**

默认 `maxRetries` 为 0。重试判断只识别 driver error code；退避发生在失败 attempt 已 rollback/revoke 后。每次等待前后检查 Provider 状态，错误记录 `attempts`，不在 retry helper 内执行 callback 以外的业务函数。

- [ ] **步骤 6：运行 Provider 全套测试并提交**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/database-provider.test.ts
pnpm --filter @colorful-code/server typecheck
```

预期：全部 PASS，typecheck exit 0。

```bash
git add apps/server/src/persistence/database-provider.ts apps/server/test/database-provider.test.ts
git commit -m "feat(持久化): 添加受控事务与忙重试边界"
```

### 任务 3：迁移 SessionStore 到统一内核

**文件：**

- 创建：`apps/server/src/persistence/database-provider.module.ts`
- 修改：`apps/server/src/persistence/persistence.module.ts`
- 修改：`apps/server/src/persistence/session-store.ts`
- 修改：`apps/server/src/sessions/sessions.service.ts`
- 修改：`apps/server/src/sessions/projects.controller.ts`
- 修改：`apps/server/test/session-store.test.ts`
- 修改：所有直接调用 `SessionStore.openAt()` 或异步写方法的 server 测试。

- [ ] **步骤 1：把 SessionStore 测试改成受控 Provider 并新增 Clock/事务断言**

测试 helper 创建 test Provider 和 store，`finally` 关闭 Provider。写方法改为 `await`。新增固定 Clock 断言 generated `createdAt/updatedAt`，以及 delete fault 后 audit、checkpoint、metadata、session 全部保留。

```ts
await withTempStore({ now: 1234 }, async (store) => {
  const project = await store.upsertProject('/work/project');
  assert.equal(project.createdAt, 1234);
  assert.equal(project.updatedAt, 1234);
});
```

- [ ] **步骤 2：运行 SessionStore 测试确认旧实现失败**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/session-store.test.ts
```

预期：FAIL，因为 store 仍自行 open、写方法同步且使用 `Date.now()`。

- [ ] **步骤 3：实现 Provider 注入与 SessionStore 迁移**

`DatabaseProviderModule.forRoot(provider)` 导出全局 `DATABASE_PROVIDER` token。`SessionStore` 构造函数只注入 Provider；删除连接字段、`openAt()` 和 `OnModuleDestroy`。所有读操作包在 `provider.read()`；所有写操作包在 `await provider.transaction()`；同一业务原子操作中的查询和更新使用同一个 `tx.database` 和 `tx.now`，不能从 transaction callback 调用返回 Promise 的 store 方法。

- [ ] **步骤 4：更新调用方与测试 factory**

Sessions service、projects controller 和测试等待写方法。测试可复用 `createTestDatabaseProvider()` 与显式 `new SessionStore(provider)`，不得重新引入业务 open 入口。

- [ ] **步骤 5：运行 1.x session 回归并提交**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/session-store.test.ts test/projects-history.e2e.test.ts test/session-restore.e2e.test.ts test/golden-path.e2e.test.ts test/session-model-config.test.ts test/system-prompt-context.test.ts
pnpm --filter @colorful-code/server typecheck
```

预期：全部 PASS。

```bash
git add apps/server/src/persistence apps/server/src/sessions apps/server/test
git commit -m "refactor(会话持久化): 接入统一数据库事务与时钟"
```

### 任务 4：迁移 PluginStore 到统一内核

**文件：**

- 修改：`apps/server/src/plugins/plugin-store.ts`
- 修改：`apps/server/src/plugins/plugins.service.ts`
- 修改：`apps/server/src/plugins/plugins.controller.ts`
- 修改：`apps/server/src/plugins/plugins.module.ts`
- 修改：`apps/server/test/plugins.test.ts`
- 修改：`apps/server/test/plugin-session-merge.test.ts`
- 修改：依赖 `PluginStore` test factory 的 server 测试。

- [ ] **步骤 1：先改测试并增加固定 Clock 断言**

测试显式创建 test Provider，注入 `PluginStore`，写方法使用 `await`。验证 install 的 `installedAt/updatedAt` 和 update 的 `updatedAt` 来自固定 Clock；同一事务字段完全相等。

- [ ] **步骤 2：运行 plugin 测试确认失败**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/plugins.test.ts test/plugin-session-merge.test.ts
```

预期：FAIL，因为旧 store 自行 open 且使用 `Date.now()`。

- [ ] **步骤 3：迁移 PluginStore 与调用链**

删除 `SERVER_ENV`、`openDatabase()`、`openAt()`、`close()` 和 `OnModuleDestroy`。read 使用 `provider.read()`，write 使用 `provider.transaction()`；需要 read-modify-write 的 install/update 在同一 transaction 中使用局部 helper，不从 callback 调用异步公共方法。Controller/Service 等待异步写入。

- [ ] **步骤 4：运行 plugin 与类型测试并提交**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/plugins.test.ts test/plugin-session-merge.test.ts test/mcp-productization.e2e.test.ts test/lsp-productization.e2e.test.ts
pnpm --filter @colorful-code/server typecheck
```

预期：全部 PASS。

```bash
git add apps/server/src/plugins apps/server/test
git commit -m "refactor(插件持久化): 统一数据库所有权与写入边界"
```

### 任务 5：daemon 生命周期与 Nest 注入闭环

**文件：**

- 修改：`apps/server/src/runtime/daemon-lifecycle.ts`
- 修改：`apps/server/src/main.ts`
- 修改：`apps/server/src/app.module.ts`
- 修改：`apps/server/test/daemon-lifecycle.test.ts`
- 修改：`apps/server/test/main-bootstrap.test.ts`
- 创建：`apps/server/test/database-kernel-lifecycle.test.ts`

- [ ] **步骤 1：编写启动顺序和逆序关闭失败测试**

扩展 fake application/provider，断言事件严格为：

```ts
[
  'acquire-lock',
  'migrate-open',
  'migrate-close',
  'provider-open',
  'create-app',
  'listen',
  'close-app',
  'provider-close',
  'release-lock',
];
```

分别注入 provider 初始化、app 创建、listen、app close、provider close 和 lock release 失败，断言逆序清理、幂等调用和原始错误在聚合错误首位。

- [ ] **步骤 2：运行 lifecycle 测试确认缺失 Provider 阶段**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/daemon-lifecycle.test.ts test/main-bootstrap.test.ts test/database-kernel-lifecycle.test.ts
```

预期：FAIL，事件缺少 Provider 创建/关闭，联合测试文件或 API 尚不存在。

- [ ] **步骤 3：实现 daemon 生命周期协调**

`StartDaemonOptions` 增加 `createProvider(databasePath)`，`createApplication(databasePath, provider)` 接收已创建 Provider。成功路径注册一个 close coordinator，按 application shutdown → Provider close → lock release 执行且物理动作幂等；启动失败复用同一 coordinator，不建立第二套清理路径。

`AppModule.forRoot(environment, provider)` 导入全局 Provider module。`createNestApplication()` 不打开数据库，只把 Provider 注入容器。

- [ ] **步骤 4：实现真实联合闭环测试**

使用真实文件路径、真实 Instance Lock、真实 migration bootstrap、真实 Provider 和固定 Clock：migration 创建测试表后业务 transaction 才能插入；失败 transaction 的数据与时间一起回滚；close 释放锁；同路径重启成功；初始化失败不留锁；等待 busy retry 时 close 后不再 BEGIN。

- [ ] **步骤 5：运行生命周期回归并提交**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/database-kernel-lifecycle.test.ts test/daemon-lifecycle.test.ts test/main-bootstrap.test.ts test/data-directory-instance-lock.test.ts test/migration-framework.test.ts test/migration-backup-recovery.test.ts
pnpm --filter @colorful-code/server typecheck
```

预期：全部 PASS。

```bash
git add apps/server/src/runtime/daemon-lifecycle.ts apps/server/src/main.ts apps/server/src/app.module.ts apps/server/test/database-kernel-lifecycle.test.ts apps/server/test/daemon-lifecycle.test.ts apps/server/test/main-bootstrap.test.ts
git commit -m "feat(运行时): 串联数据库内核启动与安全关闭"
```

### 任务 6：结构门禁、完整审计与最终未提交修整

**文件：**

- 创建：`apps/server/test/database-access-boundary.test.ts`
- 修改：门禁发现的 server 源码和测试。
- 修改：`docs/superpowers/plans/2026-07-14-database-kernel.md`，勾选实际完成步骤。

- [ ] **步骤 1：编写结构门禁失败测试**

扫描 `apps/server/src`，只允许 migration、backup/recovery、Instance Lock 和 Provider 基础设施 import `bun:sqlite` 或构造 `Database`。业务目录不得调用 `openDatabase()`，不得包含事务控制 SQL，不得在 store 生成持久化时间时调用 `Date.now()`，不得使用 async/await transaction callback，也不得在 transaction callback 中直接调用已知 `fetch`、`node:fs` 或 `node:child_process` 能力。

- [ ] **步骤 2：运行门禁并清除越界**

运行：

```bash
pnpm --filter @colorful-code/server exec bun test test/database-access-boundary.test.ts
rg -n "openDatabase\(|new Database\(|Date\.now\(|BEGIN|COMMIT|ROLLBACK" apps/server/src
```

预期：结构测试 PASS；`rg` 剩余命中均属于明确允许的基础设施或非持久化业务时间，并在测试 allowlist 中逐项解释。

- [ ] **步骤 3：运行完整门禁**

运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm prettier --check .
git diff --check
```

预期：所有命令 exit 0，无失败、warning 或格式差异。

- [ ] **步骤 4：规格逐项审计和主代理 review**

逐条对照设计文档第 2—10 节与用户列出的 Provider、Transaction、Clock、联合测试和合并门禁。检查完整 diff，特别关注：连接泄漏、重复 close、transaction facade 逃逸、错误覆盖、retry 跨生命周期、Nest shutdown hook 顺序、1.x API 兼容和 feature flag 默认关闭。

- [ ] **步骤 5：保留最终改动供用户 review**

按用户要求，不提交最后的门禁测试、review 修整和计划勾选。报告已提交的阶段性 commit、未提交文件、验证证据和仍需用户 review 的最终 diff；不 push、不创建 PR、不合并。
