# Colorful Code 2.0 路线讨论记录

> **Status: Historical / Non-normative**
>
> 本文档仅保存 Colorful Code 从 1.x 过渡到 2.0 期间的讨论历史，包含已被后续决策替代的内容，不能作为实现规范。
> 2.0 的规范性设计以以下文件为准：
>
> - `docs/superpowers/specs/2026-07-10-colorful-code-2-core-architecture-design.md`
> - `docs/superpowers/specs/2026-07-10-colorful-code-2-persistence-foundation-design.md`
> - `docs/superpowers/specs/2026-07-10-colorful-code-2-thread-contract-design.md`
> - `docs/superpowers/specs/2026-07-10-colorful-code-2-runtime-ownership-recovery-design.md`

## 记录原则

- 每次讨论后追加记录，避免最后一次性整理造成上下文丢失。
- 只记录已经达成的共识、明确分歧、待确认问题和下一步动作。
- 不把临时想法包装成最终决定；未确认内容统一放到「待讨论」或「开放问题」。
- 正式进入实现前，再将稳定结论拆分为规格说明和实现计划。

## 当前背景

项目早期为了尽快做出桌面端，优先完成了可运行的 Agent 工作台，但由此留下了一批维护成本较高的技术债。当前目标不是简单重写 UI，而是重新定义 Colorful Code 的核心架构：先稳定后端 API 和 Agent 协议，再让 CLI、macOS 客户端、未来的 Windows 客户端都消费同一套后端能力。

当前仓库形态：

- `apps/server`：NestJS Agent Server，承载会话、模型、插件、项目、历史等接口。
- `apps/cli`：已有轻量 CLI，目前更接近调试入口。
- `apps/desktop`：Tauri 桌面壳，当前作为 1.x 到 2.0 的过渡参考。
- `apps/web`：现有 Web UI，后续不再作为体验投入重点。
- `packages/tool-runtime`：Agent 工具运行时、权限、MCP、LSP、Session 等核心逻辑。
- `packages/schema`：目前基本为空，后续需要升级为真正的 wire contract 包。

## 已达成共识

### 1. 产品核心应从 UI 转向 Headless Agent Core

Colorful Code 2.0 的核心不是某一个 UI，而是一套可复用的本地 Agent 后端能力。CLI、macOS 客户端、Windows 客户端都应该只是不同呈现层。

初步分工：

- TypeScript：Agent loop、模型适配、工具协议、MCP/LSP、权限策略、Session、历史、插件 schema。
- Rust：进程管理、PTY、文件系统 watcher、原生能力、签名、更新、沙箱、桌面 sidecar 管理。
- 原生 UI：只消费稳定后端 API，不承载 Agent 业务逻辑。

### 2. CLI 使用 Ink，并升级为标准客户端

CLI 不再只是调试工具，而是用于验证后端协议是否干净的标准客户端。Ink CLI 应该覆盖完整核心能力，包括创建/恢复会话、审批工具调用、查看历史、切换模型、管理 MCP、运行诊断、机器可读输出等。

CLI 的意义：

- 逼迫后端 API 清晰、稳定、无 UI 依赖。
- 作为 2.0 前的核心验收器。
- 为 CI smoke test 和 golden path 测试提供入口。

### 3. Web UI / Tauri 降级为过渡参考

现有 Web UI 和 Tauri 壳可以作为 1.x 到 2.0 的过渡参考，但不再作为长期体验方向。2.0 的正式 macOS 体验目标是 SwiftUI 原生客户端。

短期策略：

- 不再大力投入 Web UI 体验优化。
- 保留 Tauri 作为对照和过渡壳。
- 新能力优先按后端 API + CLI 实现。
- SwiftUI 客户端可用后，再正式废弃 Web/Tauri 路线。

### 4. macOS 优先，WinUI 后置

2.0 的上线标准以 macOS 原生客户端为主。Windows 客户端可以放到 2.1+，或在有人协作时并行推进。

原因：

- 项目负责人本身是深度 macOS 用户，能更准确判断体验质量。
- 对简历和求职而言，一个完成度高、工程化扎实、体验在线的 macOS Agent 项目，比半成品全平台更有说服力。
- SwiftUI 和 WinUI 同时推进会显著放大协议不稳定带来的维护成本。

### 5. 1.x 到 2.0 的阶段路线

初步阶段划分：

```text
1.1-1.3：后端 API、协议、Session 技术债
1.4-1.5：工具运行时、权限、MCP/LSP、持久化稳定
1.6-1.8：Ink CLI 成为完整产品入口
1.8-2.0：SwiftUI macOS 客户端
2.0：macOS 正式发布，签名、公证、自动更新、CI/CD 完整
2.1+：WinUI 客户端，视协作资源推进
```

## 技术债清单初步分层

用户已编写未提交的 `CODE_REVIEW_REPORT.md`，可以作为 1.1 的输入材料。初步判断：清单质量较高，但需要从 2.0 架构目标重新分层，而不是只按 Critical / High 排序。

### 1.1 必做：Contract 与安全底座

- `packages/schema` 升级为真正的 API schema 包。
- 所有 request / response / event / control / error 都从 schema 包导出。
- Server、CLI、Web 统一消费 schema，避免各端各写一套类型。
- Session ID 改为不可预测 ID，例如 `crypto.randomUUID()`。
- 本地 API 增加认证 token。
- 错误响应统一为结构化 `ErrorEnvelope`。
- API key 不再由 Web 长期明文持久化。

### 1.1 必做：Session 正确性

- `submit()` 串行化，避免并发提交破坏 history / context。
- LSP JSON-RPC 请求增加超时和 pending 清理。
- MCP Registry、WebFetch 等远程请求增加超时。
- 修复 `configureModel()` 重复创建 model client 的问题。
- 持久化失败不能静默吞掉，至少需要结构化日志。

### 1.2-1.3：状态恢复与持久化性能

- SSE replay buffer 改为 ring buffer，或升级为 snapshot + delta。
- Checkpoint 列表接口只返回 metadata，恢复时再加载完整 snapshot。
- Session 历史列表不再全量解析完整 snapshot。
- `SessionStore` 与 `PluginStore` 统一数据库连接生命周期。
- 启动预加载 recent sessions 改为懒加载，或只预加载 pinned / 最近 N 个。

### 1.4-1.5：工具运行时与权限模型

- 重新审视 shell 执行安全模型，至少移除 login shell 行为。
- 文件系统 sandbox 策略需要明确边界和限制。
- MCP/LSP 插件生命周期、信任级别、错误恢复需要更稳定。
- 权限审计、策略持久化、审批建议需要成为 contract 的一部分。

## Contract 初步方向

### 核心原则

- 先有 wire contract，再由 Server 和 Clients 实现。
- HTTP/SSE 只是 transport，不代表 contract 本身。
- `tool-runtime` 内部类型不能直接裸露给客户端。
- 所有客户端都只依赖 `packages/schema` 中定义的稳定 wire shape。
- 每个事件必须具备基本元数据，便于重连、恢复和调试。
- 敏感字段需要在 schema 层明确标注，不依赖约定俗成。

### 初步目录结构

```text
packages/schema/src/
  api.ts
  control.ts
  daemon.ts
  errors.ts
  events.ts
  model.ts
  permissions.ts
  plugins.ts
  project.ts
  session.ts
```

### 初步 API 分组

```text
GET  /v1/health
GET  /v1/daemon/status

GET  /v1/models/presets
POST /v1/models/test
POST /v1/models/list

GET  /v1/projects
POST /v1/projects
DELETE /v1/projects/:projectId

GET  /v1/sessions
POST /v1/sessions
GET  /v1/sessions/:sessionId
PATCH /v1/sessions/:sessionId
DELETE /v1/sessions/:sessionId

POST /v1/sessions/:sessionId/messages
POST /v1/sessions/:sessionId/control
GET  /v1/sessions/:sessionId/events

GET  /v1/sessions/:sessionId/checkpoints
POST /v1/sessions/:sessionId/checkpoints/:checkpointId/restore
POST /v1/sessions/:sessionId/checkpoints/:checkpointId/fork

GET  /v1/plugins/installed
POST /v1/plugins/install
PATCH /v1/plugins/installed/:pluginId
DELETE /v1/plugins/installed/:pluginId
```

### 暂定 schema 技术路线

第一版建议使用：

```text
Zod schema + TypeScript types + 手写 HTTP client
```

暂不优先引入 OpenAPI 生成器。原因是当前最重要的是先把语义做清楚。SwiftUI 客户端需要接入时，可以再补 OpenAPI 或导出 JSON schema。

## 待讨论主题

### 下一个主题：Session Contract

优先讨论 Session Contract，因为它是 Agent 产品的核心，影响 create / restore / message / control / event / snapshot / checkpoint 等所有主流程。

需要重点确认：

- Session 是什么：一次聊天、一个项目上下文、还是一个可恢复运行容器？
- Run 和 Session 的关系。
- Message、Control、Event 的边界。
- 创建、恢复、fork、checkpoint 的语义。
- 事件流是否采用 snapshot + delta。
- SSE reconnect 如何恢复。
- Approval、edit decision、cancel、compact 是否都属于 control。
- 哪些字段是 stable contract，哪些只是 UI 派生状态。

## 开放问题

- Voice 是否进入第一版 core contract，还是作为客户端能力后置。
- 是否保留 `/sessions/:id/messages`，还是统一走 `/control` 中的 `user_message`。
- 是否从第一版开始引入 `/v1` namespace。
- 本地 API token 的生命周期由 daemon 生成，还是由客户端启动时协商。
- SwiftUI 客户端是否直接访问 HTTP/SSE，还是通过本地 IPC wrapper。

## 2026-07-10 决策记录：先建立稳定性门禁，再扩大 2.0 实现

### 审计背景

在已有 `docs/CODE_REVIEW_REPORT.md` 基础上，重新审查了 Session、Tool Scheduler、Permission、SSE、SQLite、Web/CLI 状态流和桌面进程生命周期。此次审查额外使用了可控 Promise/barrier 复现，不只依赖静态阅读。

结论是：现有问题不能全部归类为“1.x 技术债，等 2.0 重写”。其中一部分会直接决定 2.0 Contract，如果不先确定不变量，CLI、SwiftUI 和未来 WinUI 会各自实现不同的重连、审批、取消和恢复语义。

### 阶段性决策

采用“安全热修 + 核心稳定性门禁 + Contract 冻结”三条相邻工作流，而不是在“先修完所有问题”与“直接推进 2.0”之间二选一。

1. **立即热修可被独立利用或稳定造成数据损坏的问题。** 不等待大重构。
2. **暂停扩大客户端功能面。** Web/Tauri 只做必要稳定性修复，不继续投入体验重构。
3. **继续推进 2.0 Contract 设计。** 但 Contract 必须先回答 Session 状态机与事件恢复问题，再写完整 CLI/SwiftUI。
4. **核心实现与 Contract 共同收敛。** 不先写一份脱离实现验证的“大而全协议”。
5. **性能与代码整洁类债务后置。** 不让低风险清理挤占正确性门禁。

### Gate 0：立即热修

以下问题应直接修在当前主干，并补最小回归测试：

- Named model preset 禁止携带服务端 API Key 访问请求方覆盖的 `baseURL`。
- 本地 API token、随机 Session ID，以及敏感 endpoint 的来源校验。
- MCP blocked trust 不能被 `plan`、`readOnly`、`acceptEdits`、`workspaceWrite` 绕过。
- Bash “只读”分类修复：`find -delete`、`find -exec`、`git log --output` 等不能自动放行或并发。
- `cancel` 后不能新增 approval 或启动后续工具。
- manual compaction 增加 single-flight；在完整状态机落地前，可先拒绝重复请求。
- 已配置 Session 的 model switch 必须真正替换运行时 client。
- Web 运行中禁止 Enter 继续 submit；approval 失败后保留重试入口；Permission Mode 等待 Server ack。

### Gate 1：Headless Core 稳定性门禁

#### Session actor，而不是全局大锁

Session 需要明确的操作通道：

- **串行命令：** submit、compact、configure model、restore、checkpoint swap、close。
- **中断命令：** cancel、approval response。它们必须携带 run epoch，并能在当前 run 等待时立即处理。
- **独立子状态机：** edit proposal、voice request、MCP/LSP connection 各有 generation 和终态。

不能简单用一把 mutex 包住整轮 run。run 可能等待 approval；如果 approval response 也等待同一把锁，会制造真实死锁。

Session 的最小不变量：

- 同一 Session 同时只能有 1 个主操作：run、compaction、restore、checkpoint swap、model switch 或 close。它们不能并发修改 Session 状态。
- cancel、approval response 和 steer 属于中断通道，可以在主操作等待时立即进入，但仍需通过 run identity 和 generation fencing 校验。
- `cancelled`、`closing`、`closed` 为单调状态，过期异步结果不能重新打开状态。
- `close()` 返回后，不再产生 Session event、文件写入、模型输出或子进程副作用。
- 每个 tool call 必须进入 completed / error / cancelled 之一，批次失败仍要 drain sibling。
- proposal 状态转换合法且幂等，重复或迟到 control 不改变已提交终态。

#### Workspace mutation coordinator

Tool Scheduler 的“单 Session 串行写”不足以保护同一 workspace。需要按 canonical path 或 workspace root 建立 keyed coordinator：

- 单文件写采用 revision/CAS 与临时文件原子 rename。
- 多文件写具备 journal/rollback，或至少暴露 partial result。
- 不同 workspace 可以并行；同一路径的 mutation 串行。
- 读取可以并行，但 read snapshot 不能被更旧或不完整结果覆盖。

#### Structured concurrency

Model、MCP、LSP、Hook、Watcher、Bash background process 都必须属于明确的生命周期 scope：

- connect/start 使用 single-flight。
- timeout 能触发真实取消，而不是只放弃等待。
- close 会 cancel 并 drain in-flight task。
- late result 在提交前检查 generation。
- 并发数量有上限和可观测指标。

### Gate 2：Session Contract 冻结条件

原有“下一个主题：Session Contract”继续成立，但需要新增以下强制字段与语义。

#### 身份与版本

- `sessionId`：稳定容器身份，不承担鉴权职责。
- `incarnationId`：本次 daemon restore / rehydrate 后的运行实例身份，用于隔离旧连接和旧异步结果。
- `revision`：Session 持久状态版本，每次成功 mutation 后递增，用于并发写校验。
- `runId`：单次执行身份，不可从压缩后的 history 条数推导，应使用 UUID 或持久化单调序号。
- `eventSeq`：在同一 incarnation 内单调递增。
- `eventId`：由 `incarnationId + eventSeq` 唯一确定，用于重连和幂等应用。
- `schemaVersion`：客户端遇到不支持的版本应明确失败或请求 snapshot，不能静默忽略。

#### Event 与重连

- SSE 明确为至少一次投递，客户端必须按 `eventId` 幂等应用。
- 重连使用 `Last-Event-ID` 或显式 cursor，只返回缺失 delta。
- 恢复采用 snapshot + delta；`message_delta`、file watcher 等瞬时高频事件不进入无限 replay log。
- checkpoint swap 产生新 epoch，并让旧 stream complete 或发送明确的 replaced 终态。
- approval 需要 pending / acknowledged / resolved / expired 状态，不能只靠一条 `approval_required`。

#### Control

- 每条 control 带 `commandId`、`incarnationId`，涉及 run 时再带 `runId`，涉及持久 mutation 时可再带预期 `revision`。
- Server 对重复 command 幂等，并返回 accepted / rejected / stale 的结构化 ack。
- cancel、approval、edit decision 的迟到响应不能作用于下一轮。
- `user_message` 是排队、拒绝还是 interrupt，必须成为 Contract，而不是由不同客户端自行决定。

#### Permission 与插件

- blocked trust 和 sandbox boundary 是不可被普通 mode/rule 放宽的 ceiling。
- `readOnly`、`sideEffectFree`、`concurrencySafe` 分开建模；MCP annotation 只能作为 hint。
- Session restore 后 rules、trust 和 workspace boundary 不得静默丢失。
- plugin disable/delete/trust revocation 对 live Session 是立即生效、下轮生效还是强制 epoch 切换，需要写入 Contract。

### Gate 3：Persistence 与 CLI 验收

#### Persistence

- `SessionStore` 与 `PluginStore` 使用共享 DatabaseProvider。
- SQLite 设置有限 `busy_timeout`，并记录 `SQLITE_BUSY`、重试与 transaction rollback。
- delete、checkpoint restore/fork、snapshot + audit flush 使用 transaction。
- audit 只有在 commit 成功后才从内存队列确认删除。
- `currentCheckpointId` 持久化，不再通过“最新 checkpoint”猜测当前指针。
- JSON snapshot 有 schema version、逐行隔离与迁移/quarantine 路径。

#### CLI 作为门禁客户端

CLI 在进入 SwiftUI 实现前，应通过以下故障场景：

- create → message → tool → approval → completed。
- cancel-before-approval、cancel-between-tools、重复 cancel。
- SSE 断线、重复事件、按 cursor 续传。
- restore/checkpoint swap 后 epoch 更新与旧 stream 终止。
- model switch 生效且不跨 run 混用 provider。
- Server 重启后 rules、trust、checkpoint pointer 与 run identity 保持一致。
- CLI 任一 HTTP/SSE 分支失败时都会统一 abort、drain 并退出。

### 调整后的阶段路线

```text
当前主干：Gate 0 安全与数据损坏热修
1.1：Gate 1 Session / Scheduler / Lifecycle 稳定性
1.2：Gate 2 Schema + Event Envelope + Control Ack
1.3：Gate 3 SQLite 事务、迁移、恢复与故障注入
1.4-1.5：工具权限、MCP/LSP、workspace mutation 完整化
1.6-1.8：Ink CLI 达到标准客户端与发布门禁
1.8-2.0：SwiftUI macOS 客户端、签名、公证、更新
2.1+：WinUI
```

版本号仍可在正式计划中调整；这里表达的是依赖顺序。关键变化是：Event/Control Contract 不能只作为 1.1 的类型抽取任务，必须建立在 Session 状态机不变量已经通过测试的基础上。

### 明确后置的工作

以下问题存在，但不应阻塞 Gate 0/1：

- 拆分 4,000+ 行 Web 页面。
- Markdown parser 能力扩展。
- context token 展示精度。
- checkpoint 列表分页和增量压缩的长期优化。
- Web/Tauri 的体验重构。
- Voice 是否进入 core contract；若不进入，当前只修 request generation、分片顺序和资源泄漏。

### 门禁测试原则

- 时序测试使用 barrier / deferred Promise 精确控制顺序，不依赖延长 timeout。
- 每个已复现竞态先保留失败测试，再实现修复。
- CI 除 happy path 外增加 duplicate、out-of-order、timeout、abort、`SQLITE_BUSY`、process crash 测试。
- 测试通过只证明覆盖到的行为；当前 Server 仍有 2 个 restore response 断言与实现不一致，应先统一 Contract 与测试基线。

## 2026-07-10 决策记录：Active Run 的 Queue / Steer / Stop 语义

### 产品语义

借鉴 Codex 的 follow-up 行为，将 active run 期间的用户操作明确拆成 3 类，不再统一称为“打断”：

1. **Queue：排队执行。** 作为安全默认值，当前 run 结束后创建并执行下一个 run。
2. **Steer：调整当前任务。** 属于软打断，将新的用户意图注入当前 run，不创建一个语义独立的新任务。
3. **Stop：停止当前任务。** 属于硬终止，使当前 run 进入 cancelled 终态。

客户端可以允许用户选择 Queue 或 Steer 作为 active run 期间发送 follow-up 的默认行为，但 Server Contract 必须收到明确的行为类型，不能依赖不同客户端的本地猜测。

### Contract 初步约束

- Session 空闲时发送消息会创建新 run；Queue / Steer 的差异只在存在 active run 时生效。
- Queue 必须立即持久化并返回 receipt，包括 `messageId`、目标队列项和当前位置；它不能提前污染当前 run 的上下文。
- Steer 必须绑定当前 `runId` 和 `incarnationId`，迟到的 Steer 不得落入下一轮。
- Steer 是当前 run 的输入事件，不能简单实现为 `Stop + new run`。
- Stop 必须绑定当前 `runId`，幂等地推动 run 进入 cancelling / cancelled，不得停止整个 Session 或 daemon。
- Server 对 Queue、Steer、Stop 都返回结构化 command ack，并通过事件流报告最终应用结果。
- Queue 是 Server 的兜底默认值；客户端设置只决定发送时选择哪一种明确行为。

### 待继续确认

- Steer 到达模型流式生成、工具执行、等待 approval 三种阶段时，各自在什么安全边界生效。
- Stop 后已排队消息是继续执行、暂停等待确认，还是一并清空。
- 是否需要独立的 queue list / reorder / remove API。

### Steer 截断内容的持久化与上下文决策

被 Steer 截断的 assistant 输出采用“双视图”处理：

- **UI transcript：** 保留用户已经看到的完整部分输出，并标记 `finishReason: steered`。重连和恢复后仍需保持可见，不能让已展示内容消失。
- **Model context：** 默认不把被截断的 assistant 自然语言原样放回下一次模型上下文。只保留结构化的“已发生事实”，避免模型把未完成推理或半截结论当成正式答案继续使用。

可进入后续模型上下文的事实包括：

- 已提交的用户输入和已应用的 Steer 输入。
- 已经开始、完成、失败或取消的 tool call 及其结构化结果。
- 已实际提交的文件修改和对应 revision / hash。
- 已完成的 approval、permission decision、checkpoint 等状态转换。
- 为保持协议一致性所需的明确终态，例如某个输出因 Steer 被截断。

不得直接进入后续模型上下文的内容包括：

- 被 Steer 截断的 assistant 自然语言 delta。
- 未完整生成或未提交的 tool call 参数。
- 尚未应用的 approval、edit proposal 或异步任务结果。

因此持久化模型需要区分至少两类数据：用户可见的 conversation transcript，以及用于重建下一轮模型输入的 committed context / run ledger。二者不能继续由同一个 history 数组隐式承担。

### Steer 的安全边界决策

Steer 的核心原则是：**立即撤销 Agent 对未来动作的授权，但不能倒置已经发生的现实。**

收到 Steer 后，Server 必须按以下顺序执行：

1. 立即停止当前模型流。
2. 冻结新的工具调度。
3. 取消尚未开始的工具任务。
4. 对正在执行的工具发送协作式取消请求。
5. 等待或确认当前操作的实际终态。
6. 重新采集工作区和可观测外部状态。
7. 根据 Steer 指令和重新采集的事实，在同一 run 内重新规划。

Steer 不承诺回滚已经完成的文件写入、命令执行、网络请求或外部副作用。所有已发生或终态不确定的操作都必须进入 Run Ledger，并在重新规划时明确暴露给模型。

为隔离 Steer 前后的异步任务，同一 `runId` 内增加单调递增的 `planGeneration`。模型请求、工具任务、approval 和异步回调在启动时捕获 generation；旧 generation 的迟到结果可以被记录为事实，但不得继续调度新动作或覆盖新 generation 的状态。

Steer 的建议阶段状态：

```text
accepted -> quiescing -> reconciling -> applied
                              \-> failed
```

- `accepted`：命令通过 identity / generation 校验并持久化。
- `quiescing`：停止模型流、冻结调度、取消未开始任务并 drain 已开始任务。
- `reconciling`：汇总工具终态，重新采集 workspace 和可查询外部状态。
- `applied`：`planGeneration` 递增，Steer 输入进入 committed context，模型开始重新规划。
- `failed`：无法确认关键副作用或状态重采集失败；不得在信息不完整时假装安全继续。

### Steer 模块状态

Steer 模块按上述产品语义、安全边界、双视图持久化、`planGeneration` fencing 和状态重采集方案定稿。

最终边界：

- Steer 不结束当前 Run。
- Steer 撤销旧 plan generation 对未来动作的授权。
- Steer 等待旧 generation 的已启动操作进入可确认终态。
- Steer 完成 reconcile 后递增 `planGeneration`，在同一 `runId` 内继续规划。

## 2026-07-10 决策记录：Queue 与 Stop 调度控制面

### 三者边界

- **Steer：** 当前 Run 不结束，增加 `planGeneration` 后继续。
- **Stop：** 当前 Run 进入终态，不再继续规划或执行。
- **Queue：** 不属于当前 Run，而属于持久 Thread 的后续调度队列。

Queue 不建议归 Workspace 全局所有。多个 Thread 可以绑定同一 Workspace，但应分别维护用户意图和执行顺序；Workspace 层只通过 mutation coordinator 协调跨 Thread 的实际写入冲突。

如果 2.0 Contract 继续沿用 `sessionId`，其语义实际等价于持久 Thread；后续需要单独决定是否在 breaking API 中正式改名为 `threadId`。

### Stop 的默认产品决策

用户主动 Stop 时，Server 必须原子执行：

1. 先把 Thread scheduler 切换为 paused，阻止下一 Queue 项被抢占启动。
2. 冻结当前 Run 的新模型请求和工具调度。
3. 取消未开始工具，对已开始工具发送取消并 drain。
4. reconcile 已发生副作用和不确定终态。
5. 将当前 Run 推进到 cancelled 终态。
6. 保留所有尚未执行的 Queue 项，不自动启动下一项，也不默认清空。

暂停 Queue 与停止 Run 必须是一个原子控制动作，避免当前 Run 恰好结束时 Scheduler 抢先启动下一项。

清空 Queue、删除单项和恢复调度均为独立显式命令，不与 Stop 隐式绑定。

## 2026-07-10 决策记录：Thread / Run / RuntimeSession 生命周期

### 已定稿的核心结论

1. 2.0 面向用户持久历史的 API 从 `/sessions` 改为 `/threads`。
2. RuntimeSession 是加载 Thread 后产生的临时执行容器；RuntimeSession 结束不代表 Thread 结束。
3. Thread Resume 只恢复持久化逻辑状态并重新协调现实环境，不恢复旧进程的执行栈、模型流、连接、PID 或其他内存资源。

### 三层实体

#### Thread

Thread 是用户长期可见、可恢复、可归档和可分叉的持久对象，拥有：

- messages / transcript、Run 列表和 Queue。
- Queue 暂停或阻塞状态。
- Steer、Stop、Approval 和 Permission 审计。
- compaction summary、artifacts、checkpoint 引用。
- workspace binding、lineage / fork 关系。
- 默认模型、权限和 sandbox 配置，但不持久化明文 credential。

Thread 不持有进程句柄、连接、watcher、AbortController、模型流或内存 context cache。Thread 的持久生命周期使用 `available | archived | deleted`；`active` 只属于运行时投影。

#### Run

Run 是一次 Queue 项或直接输入触发的完整调度执行，是持久化对象。一个 Run 可以包含多次模型调用、工具循环和多个 `planGeneration`。

- Steer：保持同一 `runId`，递增 `planGeneration` 后继续。
- Stop：同一 `runId` 进入 `stopping -> stopped` 终态。
- 下一 Queue 项：创建新的 `runId`。

#### RuntimeSession

RuntimeSession 是某个 daemon / worker 加载 Thread 后形成的临时执行载体，持有 model client、MCP/LSP connections、sandbox、watcher、取消树、子进程、active Run task、context cache、subscriber 和 scheduler loop。

RuntimeSession 通过排他 lease 获得 Thread 执行权。新 RuntimeSession 接管时必须产生新的 `incarnationId`，旧执行载体失去调度和提交权限。

### 两层 Fencing

- `incarnationId`：隔离不同 RuntimeSession。daemon 重启、worker 接管、lease 超时和重新加载时改变。
- `planGeneration`：隔离同一 Run 内不同规划世代。Steer、显式 replan、recovery 继续执行时递增。

旧 generation 的已启动操作可以由当前 incarnation 记录实际终态，但不能更新当前计划或继续调度。旧 incarnation 的普通异步回调不得直接写入当前 Thread / Run 主状态；外部迟到事实必须通过独立的幂等 reconciliation 入口，由当前 incarnation 接纳。

### 持久化边界

必须持久化：

- Thread metadata、lineage、Queue、goal、workspace binding、默认策略配置和引用。
- Run input、状态、generation、commands、tool ledger、approval、transcript、terminal summary。
- workspace fingerprint、相关文件 revision/hash、Git 摘要、reconciliation key、tool schema/version hash、权限与 sandbox 策略快照。

不持久化为可恢复语义状态：

- Promise、AbortSignal、socket、transport、PID 存活判断、watcher、模型流、KV cache、未完成 function-call JSON 和内存锁。

资源描述符可以持久化用于 reconciliation，但不得假定原资源可以继续使用。

### 四类恢复语义

1. **Thread Read：** 只读取持久数据，不加载执行环境。
2. **Thread Resume：** 创建或复用 RuntimeSession，绑定当前环境、检测 drift，并恢复可继续工作的逻辑状态。
3. **Client Reattach：** 按 Thread 和 event cursor 补发事件并恢复订阅；不创建新 incarnation。
4. **Run Recovery：** RuntimeSession 丢失后，由新 incarnation 根据 Ledger 和现实状态决定 replan、blocked 或 failed。
5. **Workspace Restore：** 独立的有副作用操作；不得成为 Thread Resume 的隐式行为。

Thread Resume、Client Reattach、Run Recovery 和 Workspace Restore 必须在 Contract 中使用不同名称和入口。

### 恢复与现实状态

Thread 是过去观察和操作的持久记录，不是现实世界快照。RuntimeSession 加载顺序必须是：

```text
load persisted state
-> bind current environment
-> detect environment drift
-> reconcile
-> ready / blocked
```

workspace 缺失、关键文件发生变化、Git branch / HEAD 明显漂移或外部副作用不确定时，不得直接恢复自动调度。

### Queue 所有权

Queue 正式归 Thread 持久化所有，不归 RuntimeSession。Queue dispatch state 至少区分：

```text
active
pausedByUser
pausedByStop
pausedByFailure
blockedByIndeterminate
```

RuntimeSession 重建后不能未经 reconcile 自动恢复消费 Queue。

### 实体模块补充定稿

以下收紧建议全部采纳：

- Thread 持久生命周期固定为 `available | archived | deleted`，deleted 为 tombstone，物理清理由 retention / GC 完成。
- 用户和系统输入统一使用不可变 `InputItem`；Queue、Run 和 Transcript 只引用其身份。
- 旧 incarnation 的迟到结果只能进入 Late Observation Inbox，只有当前 lease holder 可以投影主状态。
- `toolExecutionId` 表示逻辑工具动作，`attemptId` 表示一次实际执行尝试；重试副作用时复用逻辑动作和幂等键。
- 普通客户端只操作 Thread / Run / Queue，不直接依赖 `runtimeSessionId`。

数据权威关系正式定义为：

```text
Immutable Inputs / Transcript / Ledger Facts
                    ↓
Thread / Run / Queue / Tool Projections
                    ↓
RuntimeSession / Model Stream / Process / MCP / Watcher
```

Transcript 只定义用户看见了什么，不是副作用事实来源。Projection 用于查询和调度，Ledger 用于审计和 recovery，RuntimeSession 是可丢弃的执行资源。不采用完全事件溯源。

## 2026-07-10 决策记录：Schema、事务矩阵与 Recovery Algorithm

### 当前持久化基线

现有 SQLite 只保存整块 `SessionSnapshot`、permission audit、checkpoint、project metadata 和 plugin record，并通过 `CREATE TABLE IF NOT EXISTS` 初始化。2.0 normalized schema 落地前必须先引入：

- `schema_migrations` 与可回滚/可验证的顺序迁移。
- 单例 `DatabaseProvider`，统一 SessionStore / PluginStore 连接和事务边界。
- `PRAGMA foreign_keys = ON`、有限 `busy_timeout`、WAL 和明确的 `synchronous` 策略。
- 旧 snapshot 到 Thread 模型的一次性 importer；迁移期间不做长期双写。

### 核心表分组

#### 不可变与追加层

- `input_items`：用户、system、steer、automation 和 recovery 输入的唯一身份；创建后不可修改。
- `transcript_items`：用户实际看到的追加式记录，包括 `finishReason: steered` 的部分 assistant 输出。
- `context_items`：可进入模型上下文的 committed canonical items，不包含被截断的自然语言 delta。
- `ledger_events`：关键命令、状态转换、审批和副作用事实。
- `late_observation_inbox`：旧 incarnation 或丢失连接返回的待验证事实。
- `artifacts`、`checkpoints`：产物和显式恢复点引用。

#### Projection 层

- `threads`：生命周期、lineage、workspace binding、默认配置、queue dispatch state、active run、revision 和当前 checkpoint。
- `queue_items`：仅引用 `inputItemId`，保存顺序、revision、状态和 resulting run。
- `runs`：一次执行的当前状态、当前 generation、来源 Queue 项和终态。
- `plan_generations`：每代的 steer / recovery 来源、context boundary、model config snapshot 和终态摘要。
- `tool_executions`：逻辑工具动作、当前状态、arguments hash 和 idempotency key。
- `tool_execution_attempts`：每次进程、网络或 transport 尝试。
- `approvals`：请求、决定、过期和关联 generation / tool execution。

#### 控制与交付层

- `runtime_leases`：Thread 排他执行 lease、holder、incarnation 和单调 fencing token。
- `command_deduplication`：按 `(clientIdentity, commandId)` 保证命令幂等并保存原始 ack。
- `event_outbox`：与 Projection / Ledger 同事务写入的 durable client event。
- `schema_migrations`：数据库版本和迁移校验。

`Run` 不再保存 `queued` 状态。排队事实只存在于 Queue；Queue 被原子消费时直接创建 `starting` Run。这样避免 Queue 与 Run 同时表达“尚未执行”。若 claim、Run 创建和 Queue consume 在同一事务，Queue 也不需要持久 `dispatching` 过渡态。

### 关键约束

- 同一 Thread 最多一个非终态 active Run，使用 partial unique index 和 `threads.active_run_id` 双重保护。
- `UNIQUE(runs.source_queue_item_id)`，一个 QueueItem 最多生成一个 Run。
- `queue_items.resulting_run_id` 唯一且与 Run 来源一致。
- `UNIQUE(client_identity, command_id)`。
- `tool_execution_id` 全局唯一；`attempt_id` 全局唯一。
- `UNIQUE(thread_id, event_sequence)`，durable client event 在 Thread 内严格有序。
- 所有 JSON payload 保存 `payloadVersion`；所有 projection 保存 schema / revision 信息。
- credential、token 和明文 API key 不进入 Thread 配置、Ledger 或事件。

### Ledger 与 Event Outbox

Ledger 使用有限 taxonomy 和版本化 payload。必须写 Ledger 的内容：

- Thread create / archive / restore / delete / fork。
- Queue enqueue / update / move / remove / consume / pause / resume。
- Run create / start / generation change / recover / block / terminal。
- Steer / Stop 各阶段和 command ack。
- Tool schedule / start / cancel request / terminal / reconciliation。
- Approval request / decision / expire。
- workspace / external observation 和 indeterminate fact。
- lease acquire / lost / takeover，以及 recovery 结论。

token delta、reasoning delta、heartbeat、typing、进度百分比和未形成语义的模型 chunk 不写 Ledger。

Projection、Ledger 和 durable event 必须在同一事务提交，并使用 `transitionId` 相关联。Ledger sequence 和客户端 event sequence 分开维护，避免假定每条内部事实都必须暴露给客户端。Outbox 至少一次发布，客户端按 `eventId` 幂等应用；已发布记录在 retention watermark 前仍作为重连 replay source。

流式 delta 是 incarnation / run 内的 transient event，可使用内存 ring buffer。daemon 重启后若 transient cursor 不可续传，Server 返回 snapshot reset；不得伪造跨 incarnation 的完整 token replay。

### Transaction Matrix

#### Thread Create / Fork

同一事务创建 Thread projection、lineage、初始配置、Ledger 和 Outbox。Fork 只复制已提交逻辑状态和引用；不复制 RuntimeSession、pending approval 或未终态工具。

#### Enqueue

同一事务：

```text
insert immutable InputItem
insert QueueItem
increment queue/thread revision
append Ledger
append Event Outbox
store command ack
```

编辑排队输入时创建新 InputItem，再 CAS 替换 QueueItem 引用；旧 InputItem 保留审计。

#### Queue Dispatch

同一事务：

```text
verify lifecycle=available
verify dispatchState=active
verify no active Run
select first queued item
create Run(status=starting)
create planGeneration=0
set Thread.activeRunId
mark QueueItem consumed + resultingRunId
append Ledger + Outbox
```

事务失败时不得留下 orphan Run 或重复消费。

#### Steer Applied

quiescing / reconciliation 在事务外执行；确认安全边界后，同一事务验证 lease、incarnation、run 和 expected generation，递增 generation，expire 旧审批，作废未提交 proposal，提交 Steer InputItem / ContextItem，更新 Run projection，并写 Ledger、Outbox 和 command result。

#### Stop Accepted / Completed

Stop accepted 的第一笔事务先原子暂停 Queue、关闭 scheduling gate、把 Run 置为 stopping，并写 Ledger / Outbox。取消和 reconcile 在事务外进行。完成后第二笔事务验证所有工具已终态或 indeterminate，将 Run 置为 stopped 或 blocked、清除 activeRunId，并保持 Queue 为 `pausedByStop` 或 `blockedByIndeterminate`。

#### Tool Side Effect

副作用不能包含在数据库事务中，必须使用 Intent / Observation：

```text
TX1: create ToolExecution + Attempt + tool.started + Outbox
execute external side effect with idempotencyKey
TX2: persist completed / failed / cancelled / indeterminate observation
```

外部系统不支持幂等键时，工具必须提供 reconciliation key，或声明为不可自动重试的高风险工具。

#### Approval Decision

同一事务 CAS pending approval，验证 incarnation / run / generation，写决定、Ledger、Outbox 和 command ack。重复命令返回原结果；迟到决定返回 stale，不能影响下一代计划。

#### Archive / Delete

Archive / tombstone delete 必须先验证无不可安全放弃的 active Run。Thread lifecycle、Queue 状态、retention metadata、Ledger 和 Outbox 同事务更新。物理删除由 GC 在独立 lease 下处理。

#### Lease Acquire / Takeover

通过 CAS 获取或接管过期 lease，生成新 `incarnationId` 并递增单调 fencing token。任何可变主状态事务都必须验证当前 lease；旧 incarnation 只能写 Late Observation Inbox。

### Command 幂等

- 客户端命令：`UNIQUE(clientIdentity, commandId)`，重复请求返回第一次 ack / result。
- Queue 消费：`sourceQueueItemId` 在 Run 上唯一。
- ToolExecution：一个逻辑动作一个 ID；所有 attempt 复用其 idempotency key。
- 外部副作用：优先使用 `agent:{threadId}:{runId}:{toolExecutionId}`；不支持时必须 reconcile 或禁止自动重试。

### Crash Recovery Algorithm

新 lease holder 接管 Thread 时：

1. CAS acquire / takeover lease，生成新 incarnation 并 fence 旧 holder。
2. 保持 Scheduler runtime gate 关闭，读取 Thread、Run、Queue 和 tool projections。
3. 校验 schema version、Thread lifecycle、workspace binding 和持久配置。
4. 读取未终态 ToolExecution、pending Approval、未提交 proposal 和 Late Observation Inbox。
5. 所有旧 pending Approval expire；未提交 proposal 作废。
6. 按 tool capability 处理旧执行：查询远端结果、检查进程/文件事实，或标记 indeterminate。
7. 重采集有限 workspace fingerprint、相关文件 hash、Git branch / HEAD / dirty summary。
8. 由当前 incarnation 验证 inbox observation；accepted fact 进入 Ledger，冲突进入 blocked。
9. 在一个事务中提交 reconciliation facts、Projection、Outbox 和 recovery decision。
10. 只有不存在关键 indeterminate、workspace drift 可兼容、旧执行已协调且 recovery policy 允许时，才能递增 `planGeneration` 并重新规划。
11. 否则 Run 进入 blocked 或 failed；Queue 保持暂停，不得自动消费下一项。

Recovery 的决策结果固定为 `continue | stop | fail | block`，每个结果必须带结构化 reason 和 evidence references。

### 1.x 数据迁移

- 先发布 migration framework，再创建 2.0 表。
- 将每个旧 SessionSnapshot 导入 Thread；生成稳定 `threadId`，保留旧 ID 作为 legacy alias。
- 旧 history 转为 InputItem / Transcript / committed ContextItem；无法准确恢复的旧 run 生成 synthetic imported Run，不伪造工具生命周期。
- permission audit 转为 Ledger / Approval audit reference；checkpoint 复制为新引用模型。
- 迁移完成后校验数量、hash 和引用完整性；旧表在至少一个稳定版本内只读保留。
- 1.x `/sessions` 进入 deprecated compatibility layer；2.0 客户端只使用 `/threads`，不做长期双写。

## 2026-07-10 决策记录：Persistence Foundation 与 2.0 Contract

### Phase 0：Persistence Foundation

第一项工程工作正式定义为：

```text
Migration Framework
-> DatabaseProvider
-> Transaction API
-> 1.x Schema Baseline
-> 2.0 Normalized Tables
-> Legacy Data Migration
```

最低交付范围：

- migration version table 和 forward-only migration。
- startup migration lock。
- 迁移前数据库备份、迁移后 integrity check，失败时恢复备份；不优先实现 down migration。
- 统一 WAL、foreign keys、busy timeout 和 transaction retry policy。
- 统一 `DatabaseProvider`、Transaction API 和 test database factory。
- 固化 1.x schema baseline，并提供 SessionSnapshot importer。

`DatabaseProvider` 是唯一连接和事务入口。Ledger、Projection、Command Deduplication 和 Event Outbox 必须共享同一事务对象。

### 2.0 公共资源

客户端直接可见：

- Thread、Run、QueueItem、InputItem、TranscriptItem。
- Approval、ToolExecutionSummary、ThreadSnapshot。

客户端不直接依赖：

- RuntimeSession、RuntimeLease、ToolExecutionAttempt。
- LateObservationInbox 和内部 Projection revision。

### Transport 决策

2.0 第一版使用 REST command/query + SSE server event stream。命令不通过 WebSocket 上行；WebSocket 可作为未来 transport adapter，但不能改变 Contract 语义。

公共路径使用 `/v2`，核心入口：

```text
POST   /v2/threads
GET    /v2/threads
GET    /v2/threads/{threadId}
PATCH  /v2/threads/{threadId}
POST   /v2/threads/{threadId}/resume
POST   /v2/threads/{threadId}/archive
POST   /v2/threads/{threadId}/restore
DELETE /v2/threads/{threadId}
POST   /v2/threads/{threadId}/fork
GET    /v2/threads/{threadId}/snapshot
GET    /v2/threads/{threadId}/events

POST   /v2/threads/{threadId}/runs
POST   /v2/threads/{threadId}/runs/{runId}/steer
POST   /v2/threads/{threadId}/runs/{runId}/stop

GET    /v2/threads/{threadId}/queue
POST   /v2/threads/{threadId}/queue/items
PATCH  /v2/threads/{threadId}/queue/items/{queueItemId}
DELETE /v2/threads/{threadId}/queue/items/{queueItemId}
POST   /v2/threads/{threadId}/queue/reorder
POST   /v2/threads/{threadId}/queue/pause
POST   /v2/threads/{threadId}/queue/resume

POST   /v2/threads/{threadId}/checkpoints/{checkpointId}/apply
```

`resume` 表示加载 Thread 并协调现实；`restore` 只表示把 archived / recoverable tombstone 恢复为 available；checkpoint 使用 `apply`，避免恢复语义混淆。

客户端直接创建 Run 只允许在 Thread 无 active Run 时执行，并原子创建 InputItem + starting Run。active Run 期间的 follow-up 必须显式选择 Queue 或 Steer，不能让 `/runs` 隐式决定行为。

### Durable 与 Transient Event

- Durable semantic event：写 Ledger + Event Outbox，拥有 `durableSequence`，可跨 daemon 重启 replay。
- Transient stream delta：只进入 incarnation ring buffer，拥有 `incarnationId + streamSequence`，不承诺跨重启恢复。

两种 sequence 属于不同空间，禁止比较大小。公共 event schema 使用以 `kind` 为 discriminator 的有限 union；`durability` 必须与 kind 一致，不能由客户端自由填写。

事件连接显式携带：

```text
durableAfter
incarnationId
streamAfter
```

不使用单独的 `Last-Event-ID` 同时表达两个 cursor 空间。服务端可额外返回 opaque resume token，但其解码语义仍是上述三项。

### Snapshot Reset

transient cursor 被驱逐、incarnation 改变、daemon 重启或流状态不可恢复时，Server 发送 `stream.snapshotReset`。

Snapshot Reset 必须包含一个一致性边界：ThreadSnapshot 与 `durableCursor` 在同一数据库 read transaction 中取得；RuntimeSession actor 再提供当前 incarnation 的 stream snapshot 和 cursor。客户端先整体替换 Projection，再应用 cursor 之后的事件。

客户端收到 reset 后必须：

- 清理旧 streaming buffer。
- 替换 Thread / Run / Queue / Approval / Transcript projection。
- 更新 incarnation 和两个 cursor。
- 禁止把旧 incarnation delta 拼接到新 stream。

ThreadSnapshot 是有界客户端 Projection，不是完整 Ledger 导出。Transcript 和 recent Runs 必须分页；当前 streamState 可以包含已聚合 partial text，但要标记 `streaming | interrupted | completed`。

### Command Ack

Command Ack 只表示命令已通过校验并在事务中持久接受，不表示异步操作完成。

重复的同 payload `commandId` 返回第一次 Ack，并使用 `replayed: true`，不能把原来的 `accepted` 改写成另一种业务状态。相同 commandId 携带不同 payload hash 时返回 `COMMAND_ID_CONFLICT`。

建议结构：

```text
commandId
operationId
status: accepted
replayed: boolean
threadId
runId?
completionEvents[]
currentDurableCursor
acceptedAt
```

语义拒绝和验证失败统一返回 ApiError，不同时维护 `rejected Ack` 与 HTTP error 两套表达。`completionEvents` 应同时列出成功和失败终态，例如 `steer.applied | steer.failed`。

### ApiError

统一错误 envelope 包含稳定 machine code、message、identity、retryable 和结构化 details。HTTP 状态与业务 code 分离：

- 400：schema / validation。
- 404：resource not found。
- 409：stale generation、revision、command id 或 terminal conflict。
- 410：已 tombstone 且不可直接访问。
- 422：资源存在但命令语义不允许。
- 503：lease、recovery 或 worker 暂不可用。

### Schema 单一来源

Zod 是唯一 authoring source，但源码按 domain 拆分，不能形成单个超大文件：

```text
packages/schema/src/common.ts
packages/schema/src/thread.ts
packages/schema/src/run.ts
packages/schema/src/queue.ts
packages/schema/src/commands.ts
packages/schema/src/events.ts
packages/schema/src/snapshot.ts
packages/schema/src/errors.ts
```

生成产物：

- OpenAPI：HTTP request / response。
- JSON Schema：Event discriminated union 和 domain payload。
- TypeScript client types / validators。
- Swift Codable models fixture。

CI 必须验证 generated artifacts 无漂移，并对 enum、optional、nullable、discriminated union 和 unknown event fallback 做跨语言 conformance test。

### 客户端状态消费

TypeScript 提供唯一 `reduceThreadEvent()`，组件只消费 reducer 后的 state。Swift 使用 actor 串行应用 snapshot、durable event 和 transient delta，再由 `@MainActor` ViewModel 暴露 UI projection。网络层不能直接修改 SwiftUI state。

### 1.x Compatibility Adapter

1.x `/sessions` 到 2.0 `/threads` 不能只做 URL 转发。兼容层必须翻译旧 request / response、SessionSnapshot 和 SessionEvent，并明确无法映射的行为。

兼容层：

- 返回 `Deprecation`、`Sunset` 和 successor `Link` headers。
- 不伪造 RuntimeSession、旧模型流或进程恢复。
- 不长期双写 1.x / 2.0 状态。
- 在迁移窗口结束后删除，而不是成为永久第二套 Contract。

### Contract 实现交付物

1. 分域 Zod public schemas。
2. `openapi.v2.json`。
3. `events.schema.json`。
4. Contract conformance tests。
5. Swift codegen / Codable fixture。

正式实现顺序：

```text
Migration Framework
-> DatabaseProvider
-> Contract Schema
-> Ledger / Projection Tables
-> Command Transactions
-> Event Outbox
-> Runtime Recovery
-> 1.x Migration Adapter
```

## 2026-07-10 决策记录：RuntimeSession Lease 与 Ownership

### 最终不变量

1. 同一 Thread 任一时刻最多只有一个合法执行所有者。
2. 旧所有者即使仍在运行，也不能继续修改当前 Projection 或调度新副作用。
3. lease 过期只撤销执行权，不证明旧 worker 已经停止。
4. takeover 必须先建立新 fencing，再执行 recovery 和现实状态协调。
5. 旧 incarnation 的迟到事实只能进入 Late Observation Inbox。

Lease 绑定 Thread，不绑定 Run。Thread lease 同时保护 active Run、Queue scheduler、Approval resolver、Steer / Stop 和 RuntimeSession resources。

### 身份与 Fence

- `workerId`：一个本地 worker 进程或执行节点。
- `daemonInstanceId`：本次 daemon 进程身份。
- `incarnationId`：某 worker 对某 Thread 的一次加载，用于日志、事件和 transient stream 隔离。
- `leaseEpoch`：Thread 所有权的数据库单调版本，作为真正 fencing token。
- `planGeneration`：同一 Run 内的逻辑规划世代。

每次 acquire / takeover 都生成新 `incarnationId`，并在数据库事务内递增 `leaseEpoch`。所有 Projection 写入和新副作用调度必须验证：

```text
threadId
workerId
incarnationId
leaseEpoch
expiresAt > databaseNow
```

Run 内动作还必须验证 `runId + planGeneration`，工具动作继续验证 `toolExecutionId + attemptId`。

### Epoch 持久化修正

安全 release 后不能丢失 epoch 历史。`threads` 保存单调 `lease_epoch_counter`；`thread_leases` 只保存当前 owner。Acquire 先递增 Thread counter，再创建当前 lease。Release 可以删除当前 lease 行，但不能回退或重置 counter。

Heartbeat 不能复活已过期 lease。Heartbeat CAS 除 identity / epoch 外必须要求 `expiresAt > databaseNow`。如果 lease 已过期，即使仍是同一个 worker，也必须等待 acquire 条件成立后以新 incarnation 和新 epoch 重新获取所有权。

`takeoverGraceMs` 只延迟新 owner 接管，不延长旧 owner 的合法写入时间。`expiresAt` 到达后立即本地 fencing；`expiresAt + grace` 到达后允许 takeover。

所有时间比较使用数据库时钟或 Transaction API 注入的统一 Clock，不使用各 worker 自己的 wall clock 决定 ownership。

### Lease Projection

持久 lease 状态只包含 `active | draining`。expired、lost、takenOver 和 closed 由时间、当前行和 Ledger 推导，不额外存成互相竞争的状态。

```text
thread_leases
  thread_id PK/FK
  worker_id
  incarnation_id UNIQUE
  lease_epoch
  state
  acquired_at
  heartbeat_at
  expires_at
  drain_deadline
```

RuntimeSession 不建立 ownership 主表。可选 `runtime_incarnations` 只用于诊断，唯一 ownership 权威是 `threads.lease_epoch_counter + thread_leases 当前行`。

### Acquire / Resume

Acquire 使用短 `BEGIN IMMEDIATE` 事务：

```text
verify Thread lifecycle=available
read current lease and databaseNow
no lease / takeover allowed -> increment leaseEpoch counter
create new incarnation and owner row
write Ledger + Outbox
commit
```

- 用户 Thread Resume 遇到其他有效 owner 时，路由或复用现有 owner并返回 Snapshot，不向客户端暴露 `LEASE_HELD`。
- 内部 worker claim 遇到有效 owner 时返回内部 `LEASE_HELD`，不得擅自 takeover。
- takeover 只在 `expiresAt + grace < databaseNow` 时允许。

### Heartbeat 与本地 Fencing

Heartbeat 只 CAS 更新 lease row，通常不写 Ledger / Outbox。策略参数可配置，并满足 `leaseTtlMs >= heartbeatIntervalMs * 3`。

Heartbeat CAS 失败、显式 revoke、发现 epoch 改变或 lease 到期时，RuntimeSession 立即：

```text
schedulingOpen=false
abort model stream
cancel scheduled tools
detach approvals
request cooperative cancellation for running tools
release local resources
```

失去 lease 后不得更新 Run、Queue、Approval、ToolExecution 或 activeRunId。它只能发送 Late Observation，并写本地诊断日志。

### Takeover 与 Recovery

Takeover 顺序固定为：

```text
CAS new lease + new epoch/incarnation
commit fencing
load projections and ledger
resolve inbox and running tools
reconcile workspace/external state
expire old approvals/proposals
decide continue / stop / fail / block
increment planGeneration only when continuing
resume scheduler only after recovery completes
```

新 owner acquire 后不能直接进入 ready / running。所有 recovery mutation 都必须验证新 lease fence。

### Graceful Drain

Drain 模式：

- `finishCurrentRun`：不创建新 Run、不消费 Queue，但允许当前 Run 在 deadline 内完成后 release。
- `handoff`：立即冻结调度、协调工具、持久化恢复事实后 release，由新 owner acquire 并 recovery。

draining 期间允许持久化新的 QueueItem，但不调度；允许 Stop；新的 Steer 返回明确 `RUNTIME_DRAINING`，不能在旧 owner 即将释放时开始新 generation。

超过 deadline 后旧 owner停止续租并执行本地 fencing。停止续租不等于 handoff 成功，新 owner仍必须等待 takeover 条件并执行 recovery。

### Stop / Steer Intent

- 已持久化但未 applied 的 Steer 在 owner 丢失后不能消失。新 owner recovery 后决定继续应用、按 stale policy 转 Queue，或因 indeterminate 保持 blocked。
- 已 accepted 的 Stop 是持久 Run intent。新 owner必须在 recovery 中继续完成 stopping，最终进入 stopped 或 blocked。
- takeover 后旧 Approval 全部 expire；需要继续同一动作时创建新 Approval。

### Late Observation Inbox

任何非当前 owner 的事实只能 append inbox，不得修改主 Projection。Inbox 使用稳定 `dedupKey` 唯一约束，不使用包含 nullable `toolExecutionId / attemptId` 的复合 UNIQUE，因为 SQLite 的 NULL 语义不能可靠去重。

`dedupKey` 由 canonical payload hash 和来源身份生成：

```text
sourceIncarnationId
sourceLeaseEpoch
toolExecutionId?
attemptId?
kind
canonicalPayloadHash
```

payload 必须先通过对应 kind 的版本化 schema 和来源认证。只有当前 lease holder 可以把 pending observation 判为 accepted / rejected / conflict，并在同一事务中写 Ledger Fact、Projection 和 Outbox。

与现有 Projection 冲突的事实不能简单丢弃。例如“本地已 cancelled，但远端部署成功”必须进入 conflict，随后由 reconciliation 把 Tool / Run 置为 reconciled 或 indeterminate / blocked。

### Worker Registry 边界

`worker_registry` 只用于能力发现和 liveness 辅助，不代表 Thread ownership。对于当前 SQLite 桌面架构，数据库仍由 daemon 统一持有；未来 remote sandbox / worker 通过 daemon 的受认证内部通道提交 heartbeat 和 observation，不直接共享本地 SQLite 文件。

### 事务边界

- Acquire / Takeover：lease CAS、epoch/incarnation、runtime projection、Ledger、Outbox 同事务。
- Heartbeat：只 CAS lease row，不写高频 Ledger。
- Drain：active -> draining、deadline、dispatch gate、Ledger、Outbox 同事务。
- Release：验证 fence、删除当前 lease、保留 Thread epoch counter、runtime projection、Ledger、Outbox 同事务。
- Inbox receive：只 `INSERT ... ON CONFLICT DO NOTHING`。
- Inbox resolve：当前 owner验证 fence并提交 resolution、Ledger Fact、Projection 和 Outbox。

### 测试门禁

必须覆盖：

- 双 worker acquire、有效 lease 拒绝 takeover、过期 lease 单赢家 takeover。
- lease 到期后旧 owner heartbeat / Projection / Queue / Approval / tool commit 全部失败。
- 模型、工具和 Approval 的旧 incarnation / generation 迟到回调。
- Tool 副作用完成但 Observation 未落库时 crash。
- Stop accepted、Steer accepted、Queue dispatch、Outbox publish 各阶段 crash。
- finishCurrentRun / handoff / drain timeout 和 drain 期间的 Queue / Stop / Steer。
- Late Observation 重复、一致、冲突、无对应执行和不可 reconciliation。

### 实现依赖顺序

由于 `thread_leases` 必须引用 Thread 并保留 epoch counter，lease 表不能早于最小 Thread identity schema：

```text
Migration Framework
-> DatabaseProvider + Transaction API + Clock
-> 1.x Schema Baseline
-> Minimal Thread Identity + lease_epoch_counter
-> worker_registry + thread_leases
-> lease CAS / heartbeat / fencing / drain
-> Late Observation Inbox + Recovery Coordinator
-> 2.0 Contract Schema
-> remaining normalized domain tables
-> Command Transactions + Event Outbox
-> 1.x Migration Adapter
```

### 模块定稿

每个可执行 Thread 任一时刻最多由一个有效 lease holder 拥有。每次 acquire 或 takeover 都生成新的 incarnationId，并递增数据库单调 leaseEpoch。所有 Projection 写入和新副作用调度必须通过当前且未过期的 lease fence。Lease 失效只撤销执行权，不证明旧执行已经停止。旧 incarnation 的迟到结果只能进入不可变 Late Observation Inbox，由当前 owner验证后接受为 Ledger Fact、拒绝或标记冲突。Takeover 必须先建立 fencing，再执行 recovery 和现实状态协调。

## 2026-07-10 设计审计：尚未关闭的问题

本轮按状态机、事务依赖、事件一致性、lease fencing 和锁顺序重新审查。当前讨论稿不能直接宣称“设计完全完成且不存在锁或逻辑问题”，以下项目必须在正式规格中关闭。

### 1. Snapshot Reset 缺少真正的跨层线性化屏障

当前描述先在数据库 read transaction 中读取 Projection / durable cursor，再由 RuntimeSession actor 获取 stream snapshot。两步之间仍可发生 durable mutation 或 transient delta，导致 Snapshot 已包含某项状态、客户端随后又从旧 cursor 重放同一事件，或遗漏 actor snapshot 前后的 delta。

正式方案必须由 Thread actor 建立 attach barrier：先注册 post-barrier buffer，在 actor 串行点内读取数据库 Projection + durable high-watermark 并捕获 stream state + stream cursor，再释放 barrier。网络发送期间不得持有 actor、workspace lock 或数据库 transaction。

### 2. 缺少可查询的持久异步 Operation Projection

`command_deduplication` 只能证明命令是否重复，不能可靠表示 accepted Steer / Stop / checkpoint apply 当前处于 accepted、quiescing、reconciling、applied、failed 或 blocked。系统又明确不采用完全事件溯源，因此不能要求 recovery 每次扫描 Ledger 推导所有未完成命令。

需要新增 `operations` projection，保存 `operationId`、command identity、type、target Run / generation、status、intent payload reference、terminal result 和 revision。Command Deduplication 只负责请求幂等，Operation 负责异步生命周期与 recovery。

### 3. Lease 实现顺序与事务不变量矛盾

Lease acquire / takeover / drain / release 被要求与 Ledger + Event Outbox 同事务提交，但当前实现顺序把 lease CAS 放在 Ledger / Outbox 表之前。必须先建立最小 Thread、Operation、Ledger、Outbox、Command Deduplication 基础表，再实现会产生语义状态的 lease transitions。

### 4. 缺少完整锁层级与 await 规则

Thread actor、workspace keyed coordinator、SQLite write transaction、approval wait 和 child-task drain 尚未定义统一顺序，仍存在死锁、饥饿和 lease 因长事务过期的风险。

正式规则至少包括：

- Actor 只串行状态转换，模型、工具、Approval 等长任务作为受控 child task，不占住 mailbox。
- 等待 Approval、外部 IO、tool drain 或 workspace lock 时不得持有数据库 transaction。
- Workspace 多路径锁按 canonical path 全局排序获取；Approval 在获取 mutation lock 前完成，获取后重新校验 revision/hash。
- 数据库 transaction 最后获取、保持短小，transaction callback 禁止外部 IO 和任意 `await`。
- 不在持有 workspace lock 或数据库 transaction 时等待 actor command 完成或向网络客户端发送事件。

### 5. Direct Run 与 Queue 的优先级未定义

`POST /threads/{threadId}/runs` 只检查无 active Run，但没有说明 Queue 非空、paused 或 blocked 时能否绕过队首直接执行。正式规则应规定：Direct Run 仅在无 active Run、Queue 为空且 scheduler 可调度时创建；否则客户端必须 Queue，或使用显式、审计化的 priority operation。

### 6. Lifecycle API 仍有命名冲突

讨论已接受 `undelete / resume / checkpoint apply` 分离，但当前路径仍保留 `/threads/{id}/restore`，并同时承担 archived / tombstone 恢复。正式 API 应移除泛化 restore，拆为 `unarchive`、`undelete`、`resume` 和 checkpoint `apply`。

Checkpoint apply 还必须定义为持久 Operation 或特殊 Run：暂停 Queue、要求无冲突 active Run、获取 workspace mutation locks、记录副作用和 reconciliation，不能只是普通 REST handler。

### 7. 本地 API 鉴权与 credential 生命周期仍未决定

文档只要求 API token，却没有定义生成、发现、轮换、权限和 API provider credential 引用。最低方案需要：daemon 每次启动生成高熵 bearer token，写入仅当前用户可读的 runtime discovery file；仅监听 loopback；所有敏感 endpoint 强制 Authorization；Origin / CORS 只作为补充。模型密钥进入系统凭据存储，Thread 仅保存 `credentialRef`，不保存明文。

### 8. Policy / Plugin 变更对 active Run 的语义未关闭

plugin disable/delete/trust revocation、sandbox ceiling 和 permission policy 变化仍未定义对 active generation 的影响。正式规则应使安全收紧立即关闭新调度、expire 相关 Approval、取消可取消工具并触发 reconcile / replan；安全放宽只对下一 generation 生效。

### 9. Migration 与 Transaction Retry 需要防重复副作用约束

SQLite 迁移备份必须使用 SQLite backup API 或等价的一致性快照，不能直接复制 WAL 模式下的主文件。Transaction retry 不能重新执行包含外部副作用的任意 async callback；Transaction API 的 callback 应为纯数据库、无外部 `await` 的短操作，只在 callback 尚未开始前重试 `SQLITE_BUSY`，或要求调用方提供明确幂等策略。

### 10. 当前文件是演进日志，不是无歧义正式规格

文件前部仍保留已被后续决策替代的 `/v1/sessions`、暂不生成 OpenAPI、`cancelled` Run 终态和多项开放问题。它们作为历史记录可以保留，但不能作为实现者的唯一规范。必须抽取正式 specs，并建立 superseded decision index 和跨文档一致性检查。

### 审计结论

当前方向正确，核心不变量具备可行性，但设计尚未达到可以证明“没有锁和逻辑问题”的状态。关闭上述项目、形成无历史歧义的正式规格，并通过模型化状态机测试、barrier 并发测试和故障注入后，才能表述为“未发现已知的阻塞性设计缺陷”；任何工程设计都不能在实现和验证前保证绝对无缺陷。

## 2026-07-10 正式规格关闭索引

上述审计缺口已在正式规范中完成设计层关闭：

- Snapshot linearization barrier、dual cursor 和 durableBasis：Thread Contract 第 7-9 节、Runtime 第 4 节。
- Persistent Operation Projection：Core 第 6.6 节、Persistence 第 7.3 节、Runtime 第 5 节。
- Lease 与 Ledger/Outbox 实现依赖：Persistence 第 6、10、14 节及 Implementation Roadmap Phase 0A-0E。
- Actor/SQLite/Workspace lock 和 await 规则：Runtime 第 3、6 节。
- Submission/Queue 公平性：Core 第 7.1 节、Thread Contract 第 4.2 节。
- Resume/Unarchive/Undelete/Checkpoint Apply 命名：Thread Contract 第 4.1、4.8 节。
- 本地 API 鉴权与 CredentialRef：Thread Contract 第 11-12 节。
- Policy/Plugin 安全收紧：Core 第 9 节、Runtime 第 10 节。
- SQLite retry、backup 和 migration：Persistence 第 2、5 节。
- 规范去歧义和禁用旧术语：四份 Normative specs 及 Implementation Roadmap。

这些项目目前是“规范已关闭、实现尚待验证”。只有对应状态机测试、Snapshot barrier 并发测试、死锁检测和故障注入测试通过后，才能声明未发现已知阻塞性实现缺陷。

## 2026-07-10 最终交叉审查补充

正式规格在进入编码前又关闭了以下跨模块歧义：

- `threads` 增加独立、单调的 `queue_revision`，Queue edit/reorder 统一使用 CAS。
- 非 available Thread 拒绝所有 Submission；Archive/Delete 要求无 active Run，并暂停但保留 Queue；Unarchive/Undelete 不自动恢复消费。
- Submission 立即创建 Run 和 Queue Dispatch 必须持有有效 Lease；只有完全不存在 recovery-required state 时，才能在同一事务原子 acquire 并创建 Run。
- Checkpoint Apply 要求无 active Run 和冲突性 workspace Operation，避免特殊 Run 与当前工具写入并发。
- Plan Generation 保存不可变 effective policy snapshot；能力放宽不改变当前 generation 权限，安全收紧或 mixed change 才进入 Policy Reconcile。
- 公共 Contract 增加 Policy Change API；Server 根据 canonical diff 分类，客户端不能自行声明“放宽”来绕过栅栏。
- Command payload hash 由 Server 对规范化 command identity 计算，不信任客户端 hash，也不受 JSON 字段顺序和空白影响。
- data-directory singleton instance lock 前置到打开业务数据库之前；Public Server 阶段只补 discovery/auth，不重复实现 ownership primitive。
- Compaction 可以服务于 active Run，但必须关闭 scheduling gate，并与该 Run 的模型/工具推进互斥；它不创建第二个 Run。

上述结论已写入四份 Normative specs 和 Implementation Roadmap。讨论稿继续只保存演进历史，不作为实现输入。
