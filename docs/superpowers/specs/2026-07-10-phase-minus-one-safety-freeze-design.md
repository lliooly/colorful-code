# Phase -1：1.x 安全冻结与基线设计

> **状态：已确认，待实施**
>
> 本文档把《Colorful Code 2.0 Implementation Roadmap》的 Phase -1 拆成可验证的工程边界。Phase -1 只冻结并加固现有 1.x，不提前实现 Phase 0A 的持久化内核。

## 1. 目标

Phase -1 必须同时达成以下结果：

- Web 与 Tauri 的 1.x 体验功能进入冻结状态，只接受安全性、稳定性和兼容性修复。
- 当前 SQLite Schema、`SessionSnapshot`、REST API 和测试 fixture 形成可重复验证的基线。
- 当前数据库可通过 SQLite 一致性快照流程备份，备份带完整性检查和校验清单。
- 已复现的 Promise 交错问题由 barrier 或 deferred Promise 测试稳定复现，不依赖延时碰运气。
- 仍暴露给用户的凭据外泄、preset endpoint override、blocked MCP trust 绕过和明显数据损坏路径得到修复或明确禁用。
- 2.0 代码只能进入独立模块边界，不得与旧 `SessionStore` 双写。
- 主干拥有统一且稳定的测试入口，CI 会执行该入口。

## 2. 范围边界

### 2.1 本阶段包含

- 1.x 冻结规则、维护边界和 CI 门禁。
- 现有 1.x 数据库与公开协议的 golden fixture。
- 数据库备份、验证和基线 fixture 生成工具。
- Phase -1 明确点名的安全热修和最小数据一致性修复。
- 已复现竞态的确定性回归测试。
- 2.0 feature flag 与空的独立模块入口。

### 2.2 本阶段不包含

- Migration Framework、`DatabaseProvider`、统一 Transaction API 或 2.0 Schema。
- `ThreadStore`、Ledger、Outbox、Lease、Operation Projection 或 legacy importer。
- Session actor、有界 Tool Scheduler 或完整的 generation fencing 重构。
- SwiftUI、CLI 新体验、Windows 客户端和新插件能力。
- 为解决 TOCTOU 而引入 OS 级 sandbox 或原生 `openat()` 封装。

以上能力分别属于 Phase 0A 及后续阶段。Phase -1 不通过长期兼容层或双写提前模拟它们。

## 3. 冻结与 2.0 模块边界

仓库新增 1.x 冻结说明，明确允许和禁止的变更类型。冻结由文档、目录所有权和自动化检查共同表达：

- `apps/web` 和 `apps/desktop` 只接受安全、稳定性、测试、构建和兼容性修复。
- 新的 2.0 Server 代码只能放入独立的 `apps/server/src/v2` 边界。
- `COLORFUL_CODE_V2_ENABLED` 默认关闭。关闭时不得注册 2.0 路由、后台任务或数据库写入。
- 打开 flag 时，若 2.0 模块尚未实现，只暴露明确的模块状态，不触碰 1.x `SessionStore`。
- 1.x 和 2.0 持久化所有权通过测试约束：1.x 继续只写当前表；2.0 边界不得导入 `SessionStore`。

本阶段不创建空的 `ThreadStore`，避免空壳接口演变成长期双写入口。

## 4. 基线资产

### 4.1 SQLite Schema 基线

基线使用版本化 SQL manifest，记录当前生产表、列、索引和约束。测试在临时目录创建数据库后读取 `sqlite_schema`，与 manifest 比较。

基线只描述现状，不充当 migration，也不改变用户数据库。

### 4.2 Legacy 数据库 fixture

提供确定性的 fixture 生成脚本：

- 每次从固定输入创建全新数据库，不复制开发者本机数据库。
- fixture 覆盖 session、checkpoint、audit、project、session metadata 和 installed plugin。
- snapshot 覆盖 history、permission mode、workspace roots、TODO 和可选字段。
- fixture 不包含 API key、访问令牌、真实用户路径或其他秘密。
- 相同源码与运行时版本生成的逻辑内容一致；时间戳和 ID 使用固定值。
- 测试会重新生成 fixture，并验证 Schema、行数、关键值、`foreign_key_check` 和 `integrity_check`。

生成的 fixture 是测试输入，不是生产数据库备份。

### 4.3 `SessionSnapshot` 与 API golden fixture

JSON fixture 固化以下协议：

- 完整与最小 `SessionSnapshot`。
- Session create、restore、checkpoint restore 和 list 响应。
- Model preset、permission audit 和错误响应中与 Phase -1 相关的字段。

现有 2 个 restore 测试应以当前真实响应为基线，纳入 `history` 与 `permissionMode`，不得通过删除生产字段来迁就旧断言。

协议测试比较语义 JSON，不依赖对象属性顺序。后续有意修改必须同时更新 fixture，并在变更说明中标记兼容性影响。

## 5. 数据库备份

新增显式备份命令，输入源数据库和目标目录。流程如下：

```text
open source database read-only enough for inspection
run quick_check on source
create consistent snapshot with VACUUM INTO
open snapshot
run foreign_key_check and integrity_check
write manifest with source path, timestamps, size and SHA-256
atomically publish completed backup
```

约束：

- 不直接复制 WAL 模式下的主文件。
- 默认备份目录处于 Git 忽略范围，备份文件不得提交。
- 目标文件已存在时拒绝覆盖。
- 源检查、快照创建或目标检查失败时返回非零状态，且不保留看似成功的最终文件。
- manifest 不记录 snapshot 内容、API key、tool payload 或环境变量。
- 脚本支持当前默认数据库路径，也允许显式指定其他路径。

Phase -1 会对工作区当前数据库执行一次备份，并在交付结果中报告备份位置、完整性检查和哈希；备份本身留在本机忽略目录中。

## 6. 安全热修

### 6.1 浏览器凭据持久化

- API key 不得写入 `localStorage`、IndexedDB 或其他长期浏览器存储。
- 1.x 页面只在当前页面生命周期的内存中持有请求级 key。
- 读取旧配置时主动移除已持久化的 `presetApiKeys` 和 `customApiKey`，保留非敏感选择项。
- 单元测试验证序列化结果和旧数据清理结果不含秘密字段。

本阶段不实现前端自加密。缺少独立用户密钥时，该方案只是可逆混淆。

### 6.2 Preset endpoint override

- named preset 使用服务端环境凭据时，`protocol` 和 `baseURL` 必须绑定 preset，拒绝请求覆盖。
- 请求提供自己的 API key 时，允许显式自定义 endpoint；通用自定义 endpoint 仍推荐使用 `custom` preset。
- `/models/test`、`/models/list` 和 Session 创建必须共享同一个解析规则。
- 错误响应不得回显 API key。
- 回归测试使用捕获型假 endpoint，证明服务端 key 不会发往覆盖地址。

### 6.3 Blocked MCP trust ceiling

- `blocked` 是不可被 permission mode、`readOnlyHint`、workspace path 或 allow rule 覆盖的安全 ceiling。
- blocked 检查位于 `bypass`、plan/read-only、workspace write 和普通规则之前。
- blocked 决策保留结构化 `mcpTrust` reason 并进入 audit。
- restore 必须恢复调用方提供的 permission context，不能静默重建为 `rules: []`。
- 测试覆盖 blocked MCP × 所有 permission mode，并验证 restore 后 rules/trust 不变。

### 6.4 明显数据损坏路径

Phase -1 只修复无需引入 Phase 0A 基础设施即可关闭的路径：

- `submit()` 串行化，3 个并发提交按接收顺序运行。
- manual compaction 在 active submit 或另一个 compaction 存在时进入确定性队列或明确跳过，不得并发改写 history。
- `configureModel()` 必须替换实际使用的 client，不能返回成功但保持旧 client。
- Session hard delete 的多表删除使用当前 SQLite 连接上的原子 transaction。
- permission audit 只有在持久化成功后才能从内存待写队列确认删除；失败时保留并允许重试。

完整 checkpoint generation fencing、跨连接 `DatabaseProvider` 和 restore 的持久化交换顺序留给后续阶段。

## 7. 确定性竞态测试

新增共享的 deferred/barrier 测试辅助函数，不使用增加 `setTimeout()` 的方式降低失败概率。最低覆盖：

- 3 个 submit 同时等待同一个 active run，最终顺序稳定且不丢消息。
- 双 manual compaction，以及 compact 与 submit 交错时 history 不被旧结果覆盖。
- blocked MCP 在所有 mode 下保持 deny。
- audit append 第一次失败、第二次成功时记录不丢失也不重复。
- hard delete 中途注入失败后，所有相关表仍保持删除前状态。
- preset override 不会把服务端凭据发送到请求方地址。

这些测试保留已复现失败的时序，并以行为断言为主，不绑定私有实现细节。

## 8. 测试与 CI 基线

根目录新增统一测试命令，至少运行：

- Tool Runtime Node 测试。
- Server Bun 测试。
- Web Bun 测试。
- CLI Bun 测试。
- 数据库 fixture 重建与验证。

Desktop Rust 测试保留在 macOS job。CI 的 Quality job 在 lint、typecheck、build 之外执行非 Desktop 测试；Desktop job 执行 Rust 测试。

测试门禁要求：

- 不存在已知基线失败。
- 测试不访问真实 provider、真实用户数据库或外部网络。
- fixture 与 golden 文件可从干净 checkout 重建。
- 安全回归测试必须在撤销对应修复时失败。

## 9. 错误处理与可观测性

- 备份、fixture 和基线命令使用非零退出码表示失败，并输出不含秘密的明确错误。
- 数据持久化失败不得继续伪装成功；允许不中断模型流的路径也必须记录错误并保留重试数据。
- 安全拒绝使用稳定错误类型或可断言消息，不泄漏 credential 来源和值。
- 测试辅助函数在 barrier 未按预期到达时快速失败，避免永久挂起。

## 10. 验收标准

Phase -1 只有在以下检查全部通过后才完成：

1. 根测试命令、lint、typecheck、build 和 Desktop 检查全部通过。
2. CI 配置实际运行测试，而不只是编译。
3. Legacy 数据库 fixture 可从固定输入重复生成并通过 SQLite 完整性检查。
4. 当前数据库通过一致性备份生成快照，目标 `integrity_check` 为 `ok`，manifest 含 SHA-256。
5. API key 不再进入浏览器长期存储。
6. named preset 不能携带服务端 key 访问覆盖 endpoint。
7. blocked MCP 在所有 permission mode 下均无法执行，restore 后约束仍在。
8. 并发 submit、compaction、audit retry 和 hard delete 注入测试稳定通过。
9. `COLORFUL_CODE_V2_ENABLED` 默认关闭，2.0 边界不导入或写入 1.x `SessionStore`。
10. 未修复的已知 Critical 项必须有明确禁用路径和对应测试；不得只写入文档后继续暴露。

## 11. 实施顺序

1. 先建立统一测试入口并固化当前 2 个协议漂移失败。
2. 添加 Schema、Snapshot、API 和 Legacy 数据库 fixture。
3. 添加备份工具及其失败路径测试，并备份当前数据库。
4. 按凭据存储、preset override、trust ceiling、数据一致性的顺序进行红—绿—重构。
5. 添加冻结规则和 2.0 独立边界。
6. 运行全量验证，逐项核对 Phase -1 门禁。

此顺序让每项安全改动都建立在可重复基线上，同时避免 Phase -1 与 Phase 0A 交叉实现。
