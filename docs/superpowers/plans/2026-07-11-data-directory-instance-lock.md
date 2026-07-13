# Data-directory Instance Lock 实现计划

> 使用 subagent-driven-development 与 TDD 执行；每个实现步骤先验证失败测试，再实现最小生产代码。

**目标：** daemon 在业务数据库打开前，通过独立 SQLite handle 独占数据库父目录；正常或异常退出都不留下永久锁。

**架构：** `.colorful-code.instance.lock` 是无表、无业务数据的专用 SQLite 文件。持有 `BEGIN EXCLUSIVE` 事务即持锁；`ROLLBACK` + `close` 正常释放，进程退出由 OS 自动释放。`startDaemon` 负责锁优先的生命周期编排。

**技术栈：** TypeScript 5.9、Bun 1.3 `bun:sqlite`、Node/Bun test、NestJS 11、Fastify。

## 任务 1：SQLite 锁核心

- [x] 写同目录冲突、进程内并发单赢家和不同目录并行的失败测试。
- [x] 在 canonical data dir 打开固定专用 SQLite 文件。
- [x] 设置 `PRAGMA busy_timeout = 0`，初始化空 SQLite 容器并持有 `BEGIN EXCLUSIVE`。
- [x] 仅将 `SQLITE_BUSY`/`SQLITE_LOCKED` 映射为 `DataDirectoryLockConflictError`。
- [x] 获取失败时关闭 handle，并在双重失败时聚合错误。
- [x] 删除 heartbeat、PID、mtime、stale、candidate、recovery、hard-link 等旧 lease 协议与测试 seam。

## 任务 2：释放和安全边界

- [x] 写正常释放后立即重获、重复/并发释放的测试。
- [x] `release()` 最佳努力执行 `ROLLBACK` 和 `close`，保持幂等与并发安全。
- [x] 不 unlink/rename 固定锁文件或 SQLite sidecar。
- [x] 验证专用锁数据库无表、无 Schema，不包含测试注入的敏感标记。

## 任务 3：真实进程行为

- [x] 简化持锁 fixture，只接收数据目录并输出 ready/conflict/released JSON 行。
- [x] 验证多个 daemon 同时启动只有一个 ready，冲突者清晰报错并以非零状态退出。
- [x] 验证 SIGTERM 正常释放后立即重获。
- [x] 验证 SIGKILL 且等待旧进程退出后立即重获，无 stale window。
- [x] 对首次空 SQLite 文件的瞬时 busy 做有限让步，稳定保持并发单赢家。

## 任务 4：daemon 生命周期集成

- [x] 获取锁先于应用创建和业务数据库打开。
- [x] 锁冲突短路应用创建。
- [x] 应用创建、监听或关闭失败时执行锁清理。
- [x] Fastify `onClose` 与 Nest shutdown hooks 接入统一释放路径。
- [x] 内存数据库跳过数据目录文件锁。

## 任务 5：验证与收尾

- [x] 锁测试连续运行 5 次。
- [x] 运行 lock、daemon lifecycle、main bootstrap 聚焦测试。
- [x] 运行完整 server 测试、typecheck、lint、build、prettier 与 `git diff --check`。
- [x] 独立代码审查确认原需求与范围边界。
