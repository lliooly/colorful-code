# Phase 0A Database Kernel 设计

## 1. 目标

本阶段把 `DatabaseProvider`、Transaction API 和 Database Clock 合并为统一数据库访问内核，并把现有 1.x 持久化接入该内核。完成后，daemon 对同一数据目录只有一个业务连接所有者；所有业务写入共享同一事务边界；所有由数据库操作生成的持久化时间共享同一数据库时间来源。

本阶段不创建 2.0 Thread、Operation、Ledger、Outbox 等业务表，不实现 Repository、Lease、fencing、EventMux、ThreadActor、Legacy Importer、down migration、跨进程共享写连接、通用异步事务 callback 或连接池。

## 2. 生命周期与所有权

daemon 启动顺序固定为：

```text
解析并规范化数据库路径
→ 获取数据目录 Instance Lock
→ 创建迁移前备份
→ 使用 migration bootstrap connection 执行 Migration
→ 关闭 migration bootstrap connection
→ 初始化 DatabaseProvider 业务连接
→ 创建并开放业务服务
```

退出时先停止业务服务，再关闭 `DatabaseProvider`，最后释放 Instance Lock。Migration connection 是短生命周期基础设施连接，只能传给 migration、backup 和 recovery 模块；它完成任务后必须关闭，不能进入 Nest 依赖注入容器或业务 store。

daemon 数据库生命周期协调器持有 Instance Lock。`DatabaseProvider` 持有唯一业务连接，并在进程内通过规范化数据目录注册所有权；同一数据目录的第二个 Provider 初始化必须失败，不同数据目录可以独立运行。跨进程排他继续由 Instance Lock 保证。

初始化任何阶段失败时，协调器按逆序关闭已创建的 Provider、业务应用和连接，并释放 Instance Lock。多个清理步骤同时失败时，以原始初始化错误为首个错误，通过 `AggregateError` 保留后续清理错误。

`DatabaseProvider.close()` 必须幂等。关闭开始后拒绝新的 read、transaction 和 clock 操作；正在等待 `SQLITE_BUSY` 重试的 transaction 在下一次尝试前观察 Provider 生命周期，不能跨越关闭边界重新开始事务。

## 3. DatabaseProvider

生产实现使用单条 `bun:sqlite` 业务连接，不提前实现读写双连接或连接池。连接统一配置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

Provider 对业务层暴露受控读能力和事务能力，不暴露原始 `Database` 连接、`close()`、`exec()` 或手动事务控制入口。现有 `SessionStore` 与 `PluginStore` 改为注入 Provider；生产业务源码不得再调用 `openDatabase()` 或 `new Database()`。

测试通过专用 factory 注入临时文件数据库、固定 Clock、等待器和故障点。测试能力不从生产 Nest 容器导出，也不允许调用方取得可绕过 Provider 生命周期的原始生产连接。

建议公共边界：

```ts
export interface DatabaseProvider {
  readonly dialect: 'sqlite';

  read<T>(operation: (database: ReadDatabase) => T): T;

  transaction<T>(
    operation: (transaction: TransactionContext) => T,
    options?: TransactionOptions,
  ): Promise<T>;

  close(): Promise<void>;
}

export interface TransactionContext {
  readonly database: WriteDatabase;
  readonly clock: DatabaseClock;
  readonly now: number;
}
```

`ReadDatabase` 与 `WriteDatabase` 可以封装项目现有的 Drizzle 查询能力，但必须是生命周期受控的 facade。callback 返回后，保存下来的 facade 再次使用必须抛出失效错误。

## 4. Transaction API

所有业务写入使用 `provider.transaction()`。transaction callback 必须同步，只允许 SQL、Database Clock、纯内存序列化、hash 和校验。禁止网络、文件系统、进程、sleep、模型、工具执行和其他外部副作用。

TypeScript 类型把 callback 返回值限制为非 Promise；运行时仍检查 thenable，防止类型绕过或 JavaScript 调用。callback 返回 Promise 时回滚并拒绝调用。业务源码结构测试还要拒绝：

- 直接打开 SQLite；
- 直接出现 `BEGIN`、`COMMIT` 或 `ROLLBACK` 控制语句；
- `async` transaction callback 或 callback 中的 `await`；
- transaction callback 内已知的网络、文件系统和进程 API。

静态检查无法证明任意 JavaScript 闭包的纯度，因此 API 采用最小能力 facade，CI 再覆盖可识别的越界形式；规格禁止调用方通过别名或动态调用规避门禁。

每次事务尝试执行：

```text
检查 Provider 为 open
→ BEGIN IMMEDIATE
→ 从当前连接读取一次 Database Clock
→ 执行同步 callback
→ COMMIT
```

callback、constraint 或 commit 失败时执行 `ROLLBACK`。rollback 成功后抛出原始错误；rollback 也失败时抛出 `AggregateError([originalError, rollbackError])`，不覆盖原始错误。commit 失败永远不能向调用方报告成功。

Provider 默认拒绝嵌套事务。后续确有需求时再单独设计 savepoint。

## 5. `SQLITE_BUSY` 重试

只有 SQLite 明确报告 `SQLITE_BUSY` 或 `SQLITE_LOCKED` 时才可重试。每次重试都重新执行完整的 `BEGIN → Clock → callback → COMMIT`，不能复用失败 transaction 或失效 facade。

重试策略包含最大重试次数、指数退避参数和可注入等待器。退避等待发生在两个事务尝试之间，此时不持有数据库 transaction。达到上限后抛出最后一次 SQLite 错误，并附带可测试的尝试次数信息。

默认不重试，调用方必须显式选择安全重试。安全重试 callback 仍只允许数据库内操作；业务 ID、网络、文件系统和其他副作用必须在事务外完成。结构测试验证 callback 只获得数据库能力，故障测试验证每次重试重新开始完整事务且不会把外部准备步骤放入重放范围。

## 6. Database Clock

生产 Clock 在当前 Provider 连接上执行 SQLite UTC 时间查询，返回 UTC Unix 毫秒安全整数。禁止使用本地时区字符串。测试 Clock 注入固定的 UTC Unix 毫秒整数，并与生产实现保持相同类型和精度。

每次 transaction 在 callback 前只调用一次 Clock，并把结果保存为 `transaction.now`。同一事务中的 `createdAt`、`updatedAt` 和事件时间复用该值；不同事务重新查询。事务失败时，使用该时间的持久化字段与其他数据一起回滚。

系统 wall clock 回拨时，后续事务允许得到更小的值；Clock 不伪造单调性。严格递增的序列必须在后续阶段使用数据库 sequence、逻辑版本或等价机制，不能依赖 wall clock。

Clock 查询也受 Provider 和 transaction facade 生命周期约束。Provider 关闭或 transaction 结束后必须拒绝查询。

## 7. 1.x 兼容与 2.0 边界

`SessionStore` 和 `PluginStore` 保留现有业务语义，但改为从 Nest 注入同一 Provider。现有多表删除进入统一 transaction；由 store 自己生成的持久化时间改用 transaction 的 `now`。调用方已经提供的历史时间（例如 runtime 生成的 checkpoint 或 audit 时间）按原值持久化，不在本阶段重写其业务来源。

Provider 是基础设施，不等于启用 2.0 持久化。2.0 feature flag 默认关闭时，不注册 2.0 repository，不创建 2.0 业务表，也不产生 2.0 业务写入。1.x schema 与行为继续可用。

## 8. 错误与状态模型

Provider 至少区分：

- 同目录所有权冲突；
- Provider 已关闭或正在关闭；
- transaction 嵌套；
- callback 返回 Promise；
- transaction facade 已失效；
- busy retry 已耗尽；
- 初始化、commit、rollback 和 close 的聚合失败。

Provider 状态只允许 `open → closing → closed`，不能回到 `open`。初始化未完成的实例不注册为可用 Provider；失败清理结束后必须释放进程内目录注册，使 daemon 可以重启。

## 9. 测试策略

### 9.1 Provider

- 正常初始化、读写和关闭；
- 初始化失败释放连接和目录所有权；
- 关闭后拒绝操作；
- 重复关闭幂等；
- migration connection 与业务连接隔离；
- 相同目录重复 Provider 拒绝；
- 不同目录独立运行。

### 9.2 Transaction

- 成功 commit；
- callback 抛错 rollback；
- constraint violation rollback；
- commit 失败不报告成功；
- rollback 失败保留原始错误；
- 嵌套事务拒绝；
- Promise callback 拒绝；
- `SQLITE_BUSY` 完整重试与耗尽；
- 外部准备步骤不在重放范围；
- transaction 结束后 facade 失效。

### 9.3 Clock

- 返回 UTC 毫秒安全整数；
- 固定 Clock 注入；
- 同一事务复用同一时间；
- 不同事务重新取时；
- 不产生本地时区字符串；
- 时钟回拨按原值返回；
- Provider 关闭或 transaction 失效后拒绝查询。

### 9.4 集成闭环

真实文件数据库测试覆盖：

```text
Instance Lock
→ Backup
→ Migration
→ DatabaseProvider
→ Transaction
→ Database Clock
→ Commit
→ Provider Close
→ Lock Release
```

至少验证完整启动/写入/关闭、migration 完成前业务事务不可用、transaction 使用 Provider 连接、时间来自 Clock、失败时数据和时间一起回滚、关闭后不能启动事务、关闭后释放锁、重启可打开同一数据库、初始化失败不遗留连接或锁，以及 busy retry 不跨越 Provider 生命周期。

## 10. 合并门禁

合并前必须取得以下新鲜证据：

- Database Kernel 目标测试全部通过；
- Instance Lock、Migration、Backup Recovery 和 1.x 回归测试通过；
- lint、typecheck、unit test 和完整 package build 通过；
- 源码结构扫描确认业务层没有 SQLite open、手动事务控制和持久化 `Date.now()`；
- feature flag 默认关闭时没有 2.0 业务写入；
- daemon 能以现有 1.x 配置启动、关闭并重启；
- 最终 diff 经过规格审查、代码质量审查和主代理逐项人工审查。
