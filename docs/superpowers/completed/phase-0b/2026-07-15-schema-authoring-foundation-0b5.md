# Schema Authoring Foundation 0B-5 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-4 经用户验收后才能执行；完成后停在 0B-5 Gate。

**目标：** 冻结 CommandAck、replay、ApiError、ErrorCode→HTTP status 和 Operation completion payload 契约，不实现幂等事务或 Controller。

**架构：** `ack.ts` 提供以 Zod result schema 参数化的 Ack factory；`errors.ts` 定义 ApiError 和不可变 HTTP mapping；`operations.ts` 定义 Operation terminal discriminated union。commands registry 只引用这些权威 schema，删除任何临时响应 shell。

**技术栈：** Zod 4、TypeScript、Bun test

---

### 任务 1：CommandAck 与 replay

**文件：** `packages/schema/src/ack.ts`、`packages/schema/test/command-ack.test.ts`

- [ ] **步骤 1：写基础 Ack 红灯测试**

`commandAckSchema(resultSchema?)` 产出 strict object：`commandId,operationId?,status:'accepted',replayed,threadId,runId?,result?,completionEvents?,currentDurableCursor,acceptedAt`。无 result schema 时 result 字段不得出现；有 result schema 时 result optional。cursor 必须接受超过 MAX_SAFE_INTEGER 的 decimal string。

- [ ] **步骤 2：写 replay 语义形状测试**

同一 canonical Ack fixture 仅切换 `replayed:false→true` 后仍由同一个 CommandAck schema parse；除 replayed 外，commandId、operationId、result、completionEvents、cursor 和 acceptedAt 必须逐字段相同。不得新增 `CommandReplayResult`、replay wrapper 或第二套 replay response schema；payloadHash/clientIdentity 仍不得出现在 Ack 中。

- [ ] **步骤 3：实现 factory 并由 `z.infer` 导出**

factory 不缓存 mutable schema、不写全局 registry；相同输入 schema 调用可生成等价 schema，不要求对象 identity。

### 任务 2：ApiError 与稳定 HTTP mapping

**文件：** `packages/schema/src/errors.ts`、`packages/schema/test/api-error.test.ts`

- [ ] **步骤 1：写 ApiError 红灯测试**

严格实现 `{ error:{ code,message,commandId?,threadId?,runId?,operationId?,retryable,details? } }`。details 只允许 JSON object；拒绝 Error instance、stack、cause、secret 和未知顶层字段。

- [ ] **步骤 2：写每个 ErrorCode 的 HTTP status 表测试**

映射固定为：

- 400：`VALIDATION_ERROR`
- 401：`AUTHENTICATION_REQUIRED`
- 404：Thread/Run/Queue not-found codes
- 409：revision、stale、terminal、command-id、approval、operation conflict
- 410：`THREAD_DELETED | THREAD_PURGE_STARTED`
- 422：`THREAD_ARCHIVED | THREAD_NOT_IMMEDIATELY_RUNNABLE | INDETERMINATE_SIDE_EFFECT`
- 503：`RUNTIME_DRAINING | RECOVERY_BLOCKED | CREDENTIAL_UNAVAILABLE`
- 500：`INTERNAL_ERROR`

测试 `Object.keys(errorCodeHttpStatus)` 与 ErrorCode options 一一对应，无遗漏、无额外 code；mapping `Object.freeze`，消费者不可运行时修改。

- [ ] **步骤 3：实现 mapping contract description**

除数值 map 外导出 Zod schema `errorHttpMappingSchema`，元素为 strict `{ code,httpStatus,retryableDefault,category }`，供 OpenAPI extension 与文档生成使用。category 固定为 validation/authentication/notFound/conflict/gone/semantic/unavailable/internal。

### 任务 3：Operation completion event payload

**文件：** `packages/schema/src/operations.ts`、`packages/schema/test/operation-completion.test.ts`

- [ ] **步骤 1：写三分支 terminal 红灯测试**

以 `status` discriminator 定义：completed 包含 `operationId,kind,revision,completedAt,result?`；failed 包含 `error:ApiError.error`；cancelled 包含 `reason,revision,cancelledAt,result?`。所有 branch 可含 nullable runId，禁止非终态 status。

- [ ] **步骤 2：覆盖所有 OperationKind terminal path**

表驱动对每个 OperationKind 生成 completed/failed/cancelled fixture，共 36 条；每条必须 parse。错误 branch 的 code 必须来自 ErrorCode。

- [ ] **步骤 3：接入 commands 成功响应**

修改 `commands.ts` 让 mutating endpoint response 统一引用 CommandAck factory；同步 result 和异步 operation ack 通过 result schema/operationId optional 组合表达，不增加 rejected Ack。

### 任务 4：范围、安全和完整验证

**文件：** `packages/schema/test/ack-error-invariants.test.ts`

- [ ] **步骤 1：负向字段测试**

Ack 拒绝 rejected/error status、clientIdentity/payloadHash；ApiError 拒绝 stack/secret；terminal payload 拒绝 executing/waiting。验证 CommandAck 不暗示 operation 已完成。

- [ ] **步骤 2：并发安全复核**

确认 schema factory 纯函数、HTTP mapping 深度冻结、无 singleton mutation、无 lazy async initialization。此阶段不创建 dedup store、transaction、Controller 或 operation executor。

- [ ] **步骤 3：完整验证和中间提交**

运行 test、lint、typecheck、build、format、diff check；主代理逐 code/OperationKind 核对覆盖后保留最后修正未提交。

## 0B-5 Gate

- CommandAck、replay、ApiError、全部 ErrorCode 映射与 terminal payload 冻结；
- 每个 ErrorCode 恰有一个 HTTP status，每个 OperationKind 覆盖三种 terminal status；
- 不存在 rejected Ack、client payloadHash 或 clientIdentity；
- 没有幂等事务、Controller 或执行器；
- 全部验证通过后停止，等待用户验收。
