# Data-directory Instance Lock 设计

## 目标

daemon 启动时必须先独占其业务数据库所在的数据目录，再创建 Nest 应用和打开业务数据库。同一数据目录同一时刻最多运行一个 daemon；不同数据目录互不影响。

本功能对所有 daemon 启动生效，不受 `COLORFUL_CODE_V2_ENABLED` 控制。

## 范围

本分支只实现数据目录单实例锁及其生命周期集成：

- 锁定数据库文件的父目录。
- 并发启动时只允许一个进程获得锁。
- 锁冲突时输出明确、可识别的错误并以非零状态退出。
- 正常关闭和启动失败时释放锁。
- 进程或操作系统异常退出后，锁可在有限时间内自动恢复，不形成永久死锁。
- 锁中不保存环境变量、数据库内容、认证令牌、模型密钥或其他凭据。

本分支不实现 Migration、DatabaseProvider、新 Schema、daemon discovery 或连接既有 daemon 的行为，也不重构现有 1.x store。

## 方案

新增一个独立的 `DataDirectoryInstanceLock` 组件，使用数据目录内的原子锁目录 `.colorful-code.instance.lock` 作为互斥原语。获取锁依赖文件系统 `mkdir` 的排他性：创建成功即获得所有权，`EEXIST` 表示已有竞争者。

持锁进程定期刷新锁目录的 mtime。锁超过 stale window 未更新时，竞争者可以尝试原子接管；接管过程必须避免两个竞争者同时成为赢家。正常释放会停止心跳并删除锁目录。释放操作幂等，且只能释放当前实例仍然拥有的锁。

这一方案保持纯 TypeScript/Bun 实现并覆盖 macOS、Linux 和 Windows。它不引入原生 `flock`/`LockFileEx` 扩展；异常退出后的代价是存在一个短暂、明确上界的恢复窗口。

## 锁身份与安全

每次获取锁生成随机 instance ID。锁目录内可写入仅用于所有权校验和诊断的元数据：

- 格式版本；
- instance ID；
- PID；
- 获取时间。

元数据不得包含数据库连接信息、环境变量快照、provider key、bearer token、请求内容或其他 secret。冲突错误可以报告规范化的数据目录路径和持有者 PID，但不得回显锁文件的任意原始内容。

随机 instance ID 用于释放前的所有权校验。若锁已被接管或替换，旧实例的延迟清理不得删除新实例的锁。

## 启动与关闭顺序

启动入口按以下顺序执行：

1. 加载并校验环境配置。
2. 从 `databasePath` 解析并创建数据目录；内存数据库使用进程级无文件锁语义，因为它不共享持久数据目录。
3. 获取数据目录 instance lock。
4. 创建 Nest 应用；现有 store/provider 只能从此步骤开始打开业务数据库。
5. 配置应用并监听端口。
6. daemon 生命周期内持续持有锁。
7. 正常关闭时先关闭 Nest 应用，再释放 instance lock。

若获取锁后的任意启动步骤失败，入口必须关闭已创建的应用并在 `finally` 中释放锁。SIGINT 和 SIGTERM 通过 Nest shutdown hooks 进入相同的关闭路径。未捕获异常导致进程直接退出时，心跳停止；后续 daemon 在 stale window 后恢复锁。

锁冲突必须使用专门的错误类型和稳定的用户提示，例如：

```text
Another Colorful Code daemon is already using data directory: <path>
```

入口捕获该错误后写入 stderr 并以非零状态退出，不继续创建 Nest 应用，也不打开业务数据库。

## 并发与 stale 接管

锁实现必须把竞争者分成单一赢家和明确失败者：

- 首次 `mkdir` 成功的进程成为持有者。
- 活跃锁的 mtime 在 stale window 内时，竞争者立即得到锁冲突。
- 过期锁的接管使用原子重命名或等价的 compare-and-replace 流程，使多个接管者中仍只有一个可以继续获取。
- 接管过程中发现锁已刷新、身份已变化或目标已被其他进程获取时，当前竞争者按锁冲突失败。
- 被移走的过期锁只作为当前接管尝试的临时对象清理；临时名称包含随机值，避免相互覆盖。

心跳间隔必须显著小于 stale window。测试可注入较短时序参数，生产默认值保持足够容忍调度延迟和短暂系统休眠。

## 文件边界

- `apps/server/src/runtime/data-directory-instance-lock.ts`：锁错误、获取、心跳、stale 接管与幂等释放。
- `apps/server/src/runtime/daemon-lifecycle.ts`：协调“锁 → 创建应用 → 监听 → 关闭应用 → 释放锁”的顺序，并通过依赖注入式回调支持确定性测试。
- `apps/server/src/main.ts`：加载环境，将实际 Nest bootstrap 接入 daemon lifecycle，统一处理启动错误。
- `apps/server/test/data-directory-instance-lock.test.ts`：锁原语的真实文件系统和子进程测试。
- `apps/server/test/daemon-lifecycle.test.ts`：验证数据库/应用打开顺序、冲突短路和失败清理。
- `apps/server/test/fixtures/instance-lock-holder.ts`：供并发、正常退出与强制终止测试使用的最小子进程 fixture。

## 测试策略

测试必须覆盖：

1. 同一数据目录并发获取只有一个成功。
2. 已持锁时第二个 daemon 得到明确冲突错误并退出。
3. 不同数据目录可同时获得锁。
4. 正常释放后新 daemon 可立即获得同一目录的锁。
5. 获取锁后启动失败会释放锁。
6. 持有进程被强制终止后，超过 stale window 可重新获得锁。
7. 多个进程同时接管 stale lock 时仍只有一个成功。
8. 未获得锁时不会调用应用创建函数，从而证明不会打开业务数据库。
9. 锁元数据只包含允许字段，不包含测试注入的敏感标记。
10. 重复释放安全，旧持有者不能删除已被替换的新锁。

子进程测试使用临时目录和确定性 ready 信号，避免依赖固定 sleep 判断锁是否已经获得。每个测试在 `finally` 中回收子进程和临时目录。

## 验收标准

- daemon 在任何业务数据库连接创建前获得数据目录锁。
- 同目录第二个 daemon 明确报错并非零退出。
- 正常退出后锁立即可重获；异常退出后在有界 stale window 后可重获。
- 不同数据目录并行运行。
- 并发启动和并发 stale 接管均保持单赢家。
- 锁文件不包含凭据等敏感信息。
- server 单测、类型检查、lint 和 build 全部通过。
- 变更不包含 Migration、DatabaseProvider 或 Schema 工作。
