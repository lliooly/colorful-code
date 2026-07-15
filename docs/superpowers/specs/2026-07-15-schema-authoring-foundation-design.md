# Colorful Code 2.0 Schema Authoring Foundation

> **Status: Approved implementation design for Phase 0B**
>
> 本设计实现规范 [Colorful Code 2.0 Thread Contract](./2026-07-10-colorful-code-2-thread-contract-design.md)，范围仅限公共契约、生成产物、跨语言 conformance 和漂移门禁。Controller、持久化业务表、运行时协调及 Credential Broker 均不在本阶段实现。

## 1. 目标与完成定义

Phase 0B 完成时，公共契约由 `packages/schema/src` 中的 Zod schema 唯一定义。OpenAPI、事件 JSON Schema、TypeScript 类型与 validators、Swift Codable fixture 都从同一 registry 确定性生成。TypeScript 与 Swift 使用同一组 golden fixtures 验证兼容性，CI 重新生成并拒绝任何漂移、旧术语、内部运行时类型或 secret 字段。

0B-1 至 0B-10 必须顺序交付。只有完整 Gate 通过后，后续阶段才能消费冻结契约。

## 2. Authoring 架构

`packages/schema/src` 按以下领域入口拆分，每个文件只导出 Zod schema、由 `z.infer` 得到的类型，以及生成器所需的显式 registry metadata：

- `common`：ID、时间、cursor、revision、分页与 strict object helper。
- `ids`：所有 branded resource identifier。
- `enums`：稳定公共枚举。
- `thread`、`run`、`queue`、`operations`：客户端可见资源。
- `commands`：全部 v2 mutating command、query 参数和结果。
- `ack`、`errors`：CommandAck、replay、ApiError、HTTP 映射。
- `events`、`snapshot`：双 cursor stream envelope、fallback、reset 和 snapshot。
- `auth`、`config`、`policy`：authenticated principal、discovery、CredentialRef 和 patch。
- `index`：公共 barrel 与 contract registry。

所有对象 schema 默认使用 strict 模式。正式公共 registry 不包含 `RuntimeSession`、Lease、worker routing、`ToolExecutionAttempt`、Late Observation Inbox、数据库表或内部 projection revision。`clientIdentity` 只存在于 authenticated principal 边界，不出现在客户端可提交 command schema。

## 3. 公共类型与资源边界

公共标量使用 JSON 安全表示：ID 和 ISO-8601 时间为 string；durable/stream cursor 及可能超过 JavaScript 安全整数的序列为规范十进制 string；revision、plan generation 和 snapshot version 为非负安全整数。Optional 表示字段可缺失，nullable 表示字段存在但值可以为 null，两者不互换。

资源 registry 覆盖 `ThreadView`、`RunView`、`QueueItemView`、`QueueView`、`InputItemView`、`TranscriptItemView`、`OperationView`、`ApprovalView`、`ToolExecutionSummary`、`ThreadSnapshot`。Thread lifecycle 与 runtime view 分离；runtime view 只表达公共派生状态，不泄漏 owner、lease 或 routing。

正式 `ErrorCode` 以 normative Thread Contract 的稳定集合为下限，并补齐完整 v2 command/query 所需的 not-found、revision、generation、authentication、credential、protocol 与 internal failure code。每个 code 有唯一稳定 HTTP status 映射。

## 4. Command、Query、Ack 与错误

HTTP registry 覆盖规范第 4 节的全部 endpoint：Thread lifecycle、Submission、Run query/Steer/Stop、Queue、Approval、Config、Policy、Operation、Checkpoint、Snapshot 和 Event attach。

所有修改命令包含 `commandId`。Queue mutation、Approval、Config、Policy、Steer 等命令包含各自 required expected revision/generation。Command schema 拒绝 `clientIdentity` 和未知字段。Query schema 同样 strict，并用统一 pagination contract。

成功接受使用泛型 `CommandAck`，同 command replay 只改变 `replayed`，原始结果保持同形。验证或语义拒绝只使用 `ApiError`。Operation 完成通过正式 terminal event payload 表达，本阶段不实现 deduplication transaction、Controller 或 operation executor。

## 5. Event 与 Snapshot 协议

已知事件使用 `kind` discriminated union。Durable envelope 携带十进制 string `durableSequence` 和可选 `streamBasis`；Transient envelope携带 `incarnationId`、十进制 string `streamSequence` 和 `durableBasis`。两个 cursor 空间独立。

`ThreadStreamFrame` 包含已知 durable event、已知 transient event、`SnapshotReset` 和 `UnknownEventEnvelope`。未知非关键事件必须保留 envelope 与 cursor，允许旧客户端降级；未知关键事件的 conformance 结果必须是 reset-required 或 protocol-upgrade error，不能静默应用。

`ThreadSnapshot` 是有界公共 projection，包含资源视图、durable cursor、可选 incarnation/stream cursor 和 stream state snapshot。fixture 验证 reset frame 与内嵌 snapshot cursor 完全一致。本阶段只定义 barrier 输出契约，不实现 barrier 运行逻辑。

## 6. Auth、Config、Policy 与 Secret 边界

Auth schema 定义 authenticated principal 的只读公共边界与 daemon discovery。Credential 仅以 `CredentialRef` 出现，公共 schema 不包含 token、API key、password、secret value 或可上传/导出的 credential material。

Config patch 只允许模型/provider 默认值与非安全生成参数。Policy patch 只允许 workspace trust、sandbox、network ceiling、插件能力与 credential references 等声明式边界；客户端不能提交 server 计算的 tighten/relax 分类。Credential revocation 事件只携带 reference 和受影响范围，不携带 secret。

静态检查扫描 schema source、生成产物和 fixtures，拒绝 secret-bearing 字段及内部运行时名称。允许在检查器自身的 denylist 与负向测试描述中出现这些词，但它们不能出现在正式 registry 或生成 definitions 中。

## 7. 确定性生成流水线

生成器读取同一 Zod contract registry：

1. 使用 Zod 4 原生 JSON Schema 转换构造命名 definitions。
2. 将 HTTP registry 包装为 OpenAPI 3.1 `openapi.v2.json`。
3. 将 stream frame registry输出为 `events.schema.json`。
4. TypeScript validators/types 直接由 authoring source 导出，不维护第二份手写类型。
5. Swift generator 从同一 registry 的 JSON Schema IR 输出可编译 Codable fixture；该文件是生成产物，不是 authoring source。

生成器对 registry key、object property、path、enum 和 `$defs` 进行稳定排序，使用固定缩进与换行，不写时间戳、绝对路径或环境信息。同一 commit 上重复运行两次必须 byte-for-byte 相同。

## 8. Conformance Fixtures

Golden JSON fixtures由生成脚本从 Zod-validated fixture cases 写出，TypeScript 与 Swift 测试读取同一目录。覆盖：

- 每个 enum value；
- optional 与 nullable；
- 每个核心 discriminated union branch；
- 未知非关键和未知关键事件；
- 超过 `Number.MAX_SAFE_INTEGER` 的 64-bit cursor string；
- CommandAck、replay、ApiError 和 SnapshotReset；
- CredentialRef 正例与 secret 字段反例；
- 所有 strict object 的未声明字段拒绝。

Swift fixture conformance 由 Swift Package 中的 XCTest 读取相同 JSON。Linux CI 使用可用 Swift toolchain 编译和测试，不依赖 SwiftUI、macOS app 或 Ink CLI。

## 9. Gate 与 CI

schema package 提供单一 Gate 命令，严格按以下顺序执行：

1. 重新生成全部产物；
2. 检查生成器第二次运行无 byte drift；
3. 检查 Git 工作区中受管生成路径无 diff；
4. 运行 TypeScript typecheck 和 conformance；
5. 运行 Swift fixture conformance；
6. 扫描正式 schema 与产物，拒绝 Session/Chat 代替 Thread/Run、内部 Runtime 类型及 secret 字段。

CI 在现有 quality job 中安装 Swift toolchain 或使用带 Swift 的 runner 执行相同 Gate。Gate 只检查受管 schema/fixture 路径，避免把用户无关工作区变更误判为生成漂移。

## 10. 非目标

Phase 0B 不创建 v2 Controller、REST handler、数据库业务表、Ledger、Outbox、Deduplication、ThreadActor、EventMux、Lease、Worker、Fencing、Snapshot barrier 逻辑、Credential Broker、Config/Policy 状态机、SwiftUI 或 Ink CLI。生成的 Swift 内容仅为模型与 conformance fixture。

## 11. 验收矩阵

| 阶段 | 可验证交付 |
| --- | --- |
| 0B-1 | 15 个领域入口与唯一 registry 建立 |
| 0B-2 | 基础类型、枚举、ErrorCode 与旧术语检查通过 |
| 0B-3 | 全部公共资源 parse/reject 测试通过且无内部类型 |
| 0B-4 | 完整 endpoint registry，修改命令 commandId/fencing 检查通过 |
| 0B-5 | Ack、replay、ApiError、HTTP 映射、operation terminal event 通过 |
| 0B-6 | 双 cursor、basis、unknown fallback、reset、snapshot 通过 |
| 0B-7 | principal/discovery/CredentialRef/config/policy/revocation 与 secret Gate 通过 |
| 0B-8 | 四类产物可重复、确定性生成 |
| 0B-9 | TypeScript 与 Swift 消费相同 golden fixtures 并通过 |
| 0B-10 | CI 重新生成、无漂移、跨语言 conformance 和边界扫描全部通过 |

