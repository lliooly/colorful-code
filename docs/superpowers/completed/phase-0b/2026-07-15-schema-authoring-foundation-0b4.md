# Schema Authoring Foundation 0B-4 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-3 经用户验收后才能执行；完成后停在 0B-4 Gate。

**目标：** 定义规范第 4 节全部 v2 Command、Query、path/query 参数与成功响应 schema，并建立可供 OpenAPI 生成器消费的只读 HTTP contract registry。

**架构：** `commands.ts` 是 HTTP authoring registry；每个 endpoint 由 method、path、operationId、path/query/body/result Zod schema 和 `responseKind:'query'|'commandAck'` 组成。0B-4 冻结 query response 与 mutation result，0B-5 用唯一 CommandAck factory 包装所有 `commandAck` result。registry 只保存 schema 引用并 `Object.freeze`，不注册 Controller，不包含 handler。所有 client body 使用 strict object，mutating body 必须有 commandId，clientIdentity 永远不在客户端 schema。

**技术栈：** Zod 4、TypeScript、Bun test

---

## Endpoint 覆盖矩阵

- Thread：create/list/get/patch/delete/resume/archive/unarchive/undelete/fork。
- Submission：create。
- Run：list/get/steer/stop。
- Queue：get/patch item/delete item/reorder/pause/resume。
- Approval：decision。
- Config/Policy：change。
- Operation：list/get。
- Checkpoint：list/apply。
- Snapshot：get。
- Event：attach query。

| operationId         | Method | Path                                                                  |
| ------------------- | ------ | --------------------------------------------------------------------- |
| `thread.create`     | POST   | `/v2/threads`                                                         |
| `thread.list`       | GET    | `/v2/threads`                                                         |
| `thread.get`        | GET    | `/v2/threads/{threadId}`                                              |
| `thread.patch`      | PATCH  | `/v2/threads/{threadId}`                                              |
| `thread.delete`     | DELETE | `/v2/threads/{threadId}`                                              |
| `thread.resume`     | POST   | `/v2/threads/{threadId}/resume`                                       |
| `thread.archive`    | POST   | `/v2/threads/{threadId}/archive`                                      |
| `thread.unarchive`  | POST   | `/v2/threads/{threadId}/unarchive`                                    |
| `thread.undelete`   | POST   | `/v2/threads/{threadId}/undelete`                                     |
| `thread.fork`       | POST   | `/v2/threads/{threadId}/fork`                                         |
| `submission.create` | POST   | `/v2/threads/{threadId}/submissions`                                  |
| `run.list`          | GET    | `/v2/threads/{threadId}/runs`                                         |
| `run.get`           | GET    | `/v2/threads/{threadId}/runs/{runId}`                                 |
| `run.steer`         | POST   | `/v2/threads/{threadId}/runs/{runId}/steer`                           |
| `run.stop`          | POST   | `/v2/threads/{threadId}/runs/{runId}/stop`                            |
| `queue.get`         | GET    | `/v2/threads/{threadId}/queue`                                        |
| `queue.item.patch`  | PATCH  | `/v2/threads/{threadId}/queue/items/{queueItemId}`                    |
| `queue.item.delete` | DELETE | `/v2/threads/{threadId}/queue/items/{queueItemId}`                    |
| `queue.reorder`     | POST   | `/v2/threads/{threadId}/queue/reorder`                                |
| `queue.pause`       | POST   | `/v2/threads/{threadId}/queue/pause`                                  |
| `queue.resume`      | POST   | `/v2/threads/{threadId}/queue/resume`                                 |
| `approval.decide`   | POST   | `/v2/threads/{threadId}/runs/{runId}/approvals/{approvalId}/decision` |
| `config.change`     | POST   | `/v2/threads/{threadId}/config/changes`                               |
| `policy.change`     | POST   | `/v2/threads/{threadId}/policy/changes`                               |
| `operation.list`    | GET    | `/v2/threads/{threadId}/operations`                                   |
| `operation.get`     | GET    | `/v2/threads/{threadId}/operations/{operationId}`                     |
| `checkpoint.list`   | GET    | `/v2/threads/{threadId}/checkpoints`                                  |
| `checkpoint.apply`  | POST   | `/v2/threads/{threadId}/checkpoints/{checkpointId}/apply`             |
| `snapshot.get`      | GET    | `/v2/threads/{threadId}/snapshot`                                     |
| `event.attach`      | GET    | `/v2/threads/{threadId}/events`                                       |

### 任务 1：Command 基础、Thread lifecycle 与查询

**文件：** `packages/schema/src/commands.ts`、`packages/schema/test/thread-command-contracts.test.ts`

- [ ] **步骤 1：写 command invariant 红灯测试**

建立工具测试遍历 registry：method 为 POST/PATCH/DELETE 的 mutation endpoint body 必须包含 required commandId；所有 body/path/query strict reject `clientIdentity`、`payloadHash`、未知字段。GET endpoint 不得有 commandId body。

- [ ] **步骤 2：定义 Thread schemas**

精确 body：

- create：`commandId,title?,goal?,workspaceBinding?`
- patch：`commandId,expectedThreadRevision,patch:{title?,goal?}`，patch 至少一个字段
- delete/archive/unarchive/undelete/resume：`commandId,expectedThreadRevision`
- fork：`commandId,expectedThreadRevision,boundary`，boundary 为 `latestCommitted | contextBoundary | checkpoint` discriminated union

query response 直接引用 ThreadView/Page；mutation descriptor 使用 `responseKind:'commandAck'` 并引用具体 result schema或 `undefined` result，不在 0B-4 手写 Ack envelope。list/get query 使用 page cursor/limit，limit 为 1..100。

- [ ] **步骤 3：定义 readonly registry 首批 endpoint**

registry key 使用稳定 operationId，如 `thread.create`、`thread.list`；path 参数单独 strict schema。不得把 path threadId 在 body 重复定义。

- [ ] **步骤 4：运行 targeted test**

预期 commandId、expectedThreadRevision、fork boundary 和 unknown-field tests 通过。

### 任务 2：Submission、Run control 与 Queue

**文件：** `packages/schema/src/commands.ts`、`packages/schema/test/run-queue-command-contracts.test.ts`

- [ ] **步骤 1：写 Submission/Run 红灯测试**

Submission body：`commandId,input:NewInputItem,disposition`；result 为 `runCreated | queueItemCreated`。Steer body：`commandId,expectedPlanGeneration,targetConfigRevision,expectedPolicyRevision,input,stalePolicy`，stalePolicy default enqueue。Stop body：`commandId,pauseQueue`，path 已绑定 runId；pauseQueue default true。

- [ ] **步骤 2：写 Queue mutation 红灯测试**

所有 Queue mutation required `expectedQueueRevision`。Patch item 还 required `expectedItemRevision` 和 replacement `input`。Reorder 使用 `queueItemId` 加 beforeItemId/afterItemId，二者恰有一个，禁止 index/position。Delete/pause/resume 只包含 commandId 和 queue revision。

- [ ] **步骤 3：实现 schemas 与 registry entries**

Queue get response 为 QueueView；mutation result 包含更新后的 queueRevision/必要资源，并标记 `responseKind:'commandAck'`。0B-5 统一组合 Ack envelope；0B-4 不得临时手写第二份 Ack。

- [ ] **步骤 4：验证 fencing matrix**

表驱动遍历六个 Queue mutation，删掉 expectedQueueRevision 必须失败；Patch 再删 expectedItemRevision 必须失败；Steer 任一 generation/revision 缺失必须失败。

### 任务 3：Approval、Config、Policy、Operation、Checkpoint、Snapshot、Event attach

**文件：** `packages/schema/src/commands.ts`、`packages/schema/src/config.ts`、`packages/schema/src/policy.ts`、`packages/schema/test/remaining-api-contracts.test.ts`

- [ ] **步骤 1：定义 Approval decision**

body 固定为 `commandId,expectedPlanGeneration,expectedApprovalRevision,decision,reason?`；path 绑定 threadId/runId/approvalId。拒绝 policy classification、lease/incarnation 和未知字段。

- [ ] **步骤 2：定义 Config/Policy change command shell**

Config body 为 `commandId,expectedConfigRevision,patch:configPatchSchema`；Policy body 为 `commandId,expectedPolicyRevision,patch:policyPatchSchema`。0B-4 固定结构字段：Config 允许 model/provider/providerCredentialRef/temperature/topP/maxOutputTokens/reasoningEffort/providerOptions；Policy 允许 workspaceTrust/sandbox/network/pluginCapabilities/credentialRefs/revokeCredentialRefs。两个 patch 都 strict 且至少一个字段，不能用 `z.record(unknown)` 占位；0B-7 再加入 credential、递归 secret-key 和 server-owned classification 的完整安全 refine。

- [ ] **步骤 3：定义 query/checkpoint/snapshot/event contracts**

Operation list 支持 status/kind/page；get 绑定 operationId。Checkpoint list 分页；apply body 为 `commandId,expectedThreadRevision,expectedCheckpointRevision`。Snapshot get 无 body。Event attach query 固定为 optional `durableAfter`，且 `incarnationId` 与 `streamAfter` 同时存在或同时缺失；三个 cursor 都使用 string schema。

- [ ] **步骤 4：覆盖 registry 完整性**

测试精确比较 30 个 method/path/operationId：Thread 10、Submission 1、Run 4、Queue 6、Approval 1、Config/Policy 2、Operation 2、Checkpoint 2、Snapshot 1、Event 1。测试文件逐项写出 normative method/path/operationId，禁止只断言数量。每个规范 endpoint 必须恰有一个 entry，不允许额外真实路由。

### 任务 4：安全与并发契约审查

**文件：** `packages/schema/test/command-invariants.test.ts`

- [ ] **步骤 1：全 registry 负向 mutation**

对每个 body 自动注入 `clientIdentity`、`payloadHash`、`leaseEpoch`、`workerId`、`secret` 并断言 reject。对所有 mutation 删除 commandId；对 fencing endpoint 删除对应 expected value，均必须 reject。

- [ ] **步骤 2：检查 registry 无运行时竞态**

确认 registry 是模块初始化时一次性构造的 readonly frozen data；没有 mutable registration API、全局 map 写入、异步加载、锁或 import-order dependence。未来生成器只读 registry snapshot。

- [ ] **步骤 3：完整验证与中间提交**

运行 test、lint、typecheck、build、format、diff check。主代理核对 route matrix 和规范 line 67 后保留最终修正未提交。

## 0B-4 Gate

- 规范全部 endpoint 逐项存在，method/path 唯一；
- 所有修改命令 required commandId；所有并发控制命令 required 对应 revision/generation；
- clientIdentity 和 server-derived classification/hash 不可提交；
- registry 只包含 schema metadata，不含 Controller、handler 或 REST 路由实现；
- 无 mutable registry、import-order race 或异步初始化；
- 全部验证通过后停止，等待用户验收。
