# Data-directory Instance Lock 设计

## 目标与范围

daemon 必须先独占业务数据库所在的数据目录，再创建 Nest 应用和打开业务数据库。同一数据目录同一时刻最多运行一个 daemon，不同数据目录互不影响。

本功能对所有 daemon 启动生效，不受 `COLORFUL_CODE_V2_ENABLED` 控制。

本分支只实现数据目录锁及其生命周期集成，不实现 Migration、DatabaseProvider、新 Schema、daemon discovery，也不重构现有 store。

## 锁原语

`DataDirectoryInstanceLock` 在规范化后的数据目录中打开固定文件 `.colorful-code.instance.lock`。该文件是专用于互斥的空 SQLite 数据库，不是业务数据库。每个 daemon 使用独立的 `bun:sqlite` `Database` handle，并执行：

1. `PRAGMA busy_timeout = 0`，保证 SQLite 自身不等待；
2. `VACUUM`，把首次创建的零字节文件初始化为空 SQLite 容器，不创建表、DDL 或应用 Schema；
3. `BEGIN EXCLUSIVE`，获取 SQLite/操作系统提供的独占文件锁；
4. 在 daemon 整个生命周期内强引用并保持该 handle 与事务。

首次多个进程同时初始化空文件时，SQLite 可能短暂返回 busy。实现只对这一瞬时竞争做有限次事件循环让步；已有持有者仍会快速、确定地返回冲突。

`SQLITE_BUSY` 与 `SQLITE_LOCKED`（含扩展码）映射为稳定的 `DataDirectoryLockConflictError`。其他打开、权限、磁盘或 SQLite 错误保持原样，不伪装成锁冲突。获取失败后始终尝试关闭已经打开的 handle；若原错误与关闭错误同时发生，使用 `AggregateError` 保留两者。

本方案依赖 SQLite 对本机文件系统的锁语义。数据目录必须位于 SQLite 能正确提供文件锁的 local filesystem；不承诺支持禁用文件锁或锁语义不可靠的网络/虚拟文件系统。

## 生命周期与异常恢复

正常 `release()` 先执行 `ROLLBACK`，再关闭 SQLite handle。释放是并发安全且幂等的；即使 rollback 失败也继续尝试 close，并在需要时聚合错误。成功关闭后，同一目录可立即重新获取。

异常退出时不依赖 heartbeat、PID、mtime、stale window 或接管协议。进程退出后，操作系统关闭文件描述符，SQLite 文件锁自动消失；调用方在确认旧进程已经退出后可以立即重新获取，不会留下永久死锁。

固定 `.colorful-code.instance.lock` 文件可以长期保留。SQLite 可能创建 `-journal` 等 sidecar；代码不得手工 unlink、rename 或“清理”固定文件及 sidecar，因为删除仍被其他进程打开的锁文件会破坏互斥语义。残留的数据库文件本身不代表仍持锁，是否冲突只由 SQLite/OS 锁决定。

## 安全边界

锁数据库保持空 Schema，不创建表，也不写入 owner metadata、PID、instance ID、环境变量、数据库连接信息、认证令牌、provider key 或请求内容。主文件和可能存在的 sidecar 都作为 SQLite 内部文件处理，不把原始内容回显到错误消息。

冲突消息只包含规范化的数据目录：

```text
Another Colorful Code daemon is already using data directory: <path>
```

## 启动与关闭顺序

1. 加载并校验环境配置；
2. 从 `databasePath` 解析数据目录；内存数据库不获取文件锁；
3. 获取 `DataDirectoryInstanceLock`；
4. 创建 Nest 应用，此后才允许打开业务数据库；
5. 监听端口，并在 daemon 生命周期内持锁；
6. 正常关闭、监听失败或应用创建失败时进入统一清理路径并释放锁。

SIGINT 与 SIGTERM 通过 Nest shutdown hooks 进入正常关闭路径。锁冲突时入口只输出稳定消息、设置非零退出码，不创建应用或打开业务数据库。

## 文件边界

- `apps/server/src/runtime/data-directory-instance-lock.ts`：SQLite OS-backed 锁、冲突映射和幂等释放。
- `apps/server/src/runtime/daemon-lifecycle.ts`：协调“锁 → 创建应用 → 监听 → 关闭 → 释放”。
- `apps/server/src/main.ts`：Nest/Fastify 装配和启动错误输出。
- `apps/server/test/data-directory-instance-lock.test.ts`：进程内、真实子进程、释放、崩溃与安全边界测试。
- `apps/server/test/fixtures/instance-lock-holder.ts`：真实持锁进程 fixture。

## 验收标准

- 业务数据库连接创建前已获得数据目录锁；
- 同目录并发启动只有一个 daemon 成功，其余明确报错并非零退出；
- 不同目录可并行运行；
- 正常 release 后立即可重获，重复/并发 release 安全；
- SIGKILL 后等待旧进程退出即可立即重获，无 stale 等待和永久死锁；
- 锁数据库无 Schema、owner metadata 或敏感信息；
- 不删除固定锁文件和 SQLite sidecar；
- server 测试、类型检查、lint、build 和格式检查通过；
- 变更不包含 Migration、DatabaseProvider 或新 Schema。
