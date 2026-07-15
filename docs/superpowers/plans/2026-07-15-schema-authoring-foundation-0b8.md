# Schema Authoring Foundation 0B-8 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-7 经用户验收后才能执行；完成后停在 0B-8 Gate。

**目标：** 从同一 Zod registry 确定性生成 `openapi.v2.json`、`events.schema.json`、TypeScript validators/types artifact 和 Swift Codable models fixture。

**架构：** 新建内部只读 `contractRegistry`，只引用各领域 Zod schema 和 HTTP metadata。生成器先把 Zod 转成规范化 JSON Schema IR，再由四个纯 emitter 输出。所有排序、换行和数字/string 编码固定；无时间戳、绝对路径、随机 ID 或环境信息。

**技术栈：** Zod 4 native JSON Schema、Bun、TypeScript、OpenAPI 3.1、Swift 6 Codable

---

## 文件结构

- 创建 `packages/schema/src/registry.ts`：命名 schema/http/event registry，只读且不作为客户端可变 API。
- 创建 `packages/schema/scripts/generate.ts`：唯一生成入口。
- 创建 `packages/schema/scripts/lib/stable-json.ts`：深度 key 排序和固定 JSON 输出。
- 创建 `packages/schema/scripts/lib/json-schema.ts`：Zod→命名 JSON Schema IR。
- 创建 `packages/schema/scripts/lib/openapi.ts`。
- 创建 `packages/schema/scripts/lib/events-schema.ts`。
- 创建 `packages/schema/scripts/lib/typescript.ts`。
- 创建 `packages/schema/scripts/lib/swift.ts`。
- 创建 `packages/schema/generated/openapi.v2.json`。
- 创建 `packages/schema/generated/events.schema.json`。
- 创建 `packages/schema/generated/typescript/contracts.ts`。
- 创建 `packages/schema/swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift`。
- 创建 `packages/schema/test/generation.test.ts`。

### 任务 1：唯一命名 registry 与 JSON Schema IR

**文件：** `packages/schema/src/registry.ts`、`packages/schema/scripts/lib/json-schema.ts`、`packages/schema/test/generation.test.ts`

- [ ] **步骤 1：写 registry 完整性红灯测试**

逐项列出公共 schema 名称与 HTTP operationId；测试每个 registry value 是 Zod schema/readonly endpoint descriptor、key 唯一且排序稳定。所有 exported public schema 必须进入 registry，基础 factory/helper 不进入生成 definitions。

- [ ] **步骤 2：实现深度冻结 registry**

registry 在模块初始化时由静态 object literal 构造并 deep-freeze；禁止 `register()`、mutable Map、lazy Promise、import side effect。生成器只能读取快照。

- [ ] **步骤 3：实现 Zod→IR**

使用 Zod 4 `z.toJSONSchema`，target 为 draft 2020-12/OpenAPI 3.1 可兼容子集。命名 definition 使用 registry key；strict object 必须生成 `additionalProperties:false`；branded cursor 保持 string pattern；optional/nullable 分别生成 required 缺失与 `type:null` union。

- [ ] **步骤 4：写不支持节点失败测试**

遇到 transform、function、symbol、BigInt、无法表示的 custom refine 时生成器必须以 schema name 和 path 失败，不能降级为 `{}`。

### 任务 2：OpenAPI 与 Event JSON Schema emitter

**文件：** `packages/schema/scripts/lib/openapi.ts`、`packages/schema/scripts/lib/events-schema.ts`、`packages/schema/test/generation.test.ts`

- [ ] **步骤 1：写 OpenAPI 红灯测试**

document 固定 `openapi:'3.1.0'`、info title/version、servers 空数组、paths 来自 HTTP registry、components.schemas 来自命名 IR。path/query/body/response 均引用权威 schema；ApiError 作为所有非 2xx response component。不得出现 handler/controller/server implementation metadata。

- [ ] **步骤 2：实现 operation emitter**

method/path/operationId 稳定排序；path 参数 required；requestBody 只对有 body endpoint生成；response status 与 0B-5 mapping 对齐。使用 `$ref`，不复制领域 schema inline。

- [ ] **步骤 3：写 events schema 红灯测试并实现**

root `$schema` 为 draft 2020-12，title/version 固定，`$ref` 指向 ThreadStreamFrame definition；`$defs` 包含 known envelope、SnapshotReset、UnknownEventEnvelope 和依赖资源。测试 discriminator kind/durability、64-bit cursor string 和 additionalProperties false。

### 任务 3：TypeScript 与 Swift emitter

**文件：** `packages/schema/scripts/lib/typescript.ts`、`packages/schema/scripts/lib/swift.ts`、`packages/schema/test/generation.test.ts`

- [ ] **步骤 1：生成 TypeScript artifact**

`contracts.ts` 只生成从 authoring modules 的 validator re-export，以及 `z.infer<typeof schema>` 类型；不得展开手写 interface/union。import/export 按 registry key 排序，使用 `.js` specifier。

- [ ] **步骤 2：定义 JSON Schema→Swift 映射测试**

string→String、boolean→Bool、safe integer revision/generation→Int、cursor→String、array→[T]、optional→可缺 key、nullable→`T?` 且通过 presence tracking 区分、enum→String-backed Codable enum、oneOf+discriminator→enum with associated value、strict object→Codable struct。

- [ ] **步骤 3：实现 Swift emitter**

输出固定 header（无日期/path）、Foundation import、辅助 `JSONValue`、`AnyCodingKey`、strict decoding helper、所有 enum/struct/union。未知 event fallback 生成专用 associated case；critical 行为由 0B-9 conformance 验证。Swift identifier escaping 和稳定 member ordering 必须有 fixture test。

### 任务 4：唯一生成命令与 byte determinism

**文件：** `packages/schema/scripts/generate.ts`、`packages/schema/scripts/lib/stable-json.ts`、`packages/schema/package.json`、`packages/schema/test/generation.test.ts`

- [ ] **步骤 1：实现 stable serializer**

递归按 Unicode code point 排序 object key；保留 array 语义顺序；JSON 使用 2 spaces、LF、末尾单 newline。禁止 localeCompare（受 locale 影响）、对象插入顺序和浮点非规范值。

- [ ] **步骤 2：实现原子写入**

生成器先在 package root 下创建 per-process staging directory，完整生成并验证四类输出。promotion 前用 `open(...,'wx')` 获取 `.schema-generation.lock`，锁内容含 pid、hostname、nonce 和 createdAt；碰撞时先 bounded wait。超过等待时间后，仅当锁超过 staleLockMs、hostname 为本机且 `process.kill(pid, 0)` 返回 ESRCH 时，才把旧锁原子 rename 为带 contender nonce 的 quarantine 文件并重试；活跃、过新、异地主机或内容无法解析的锁一律不删除，直接失败并给出不含环境 secret 的诊断。持锁者逐文件 atomic rename，finally 仅在 nonce 匹配时删锁；失败恢复原文件并清理 staging/quarantine。单进程内串行生成，禁止两个 emitter 写同一路径。

- [ ] **步骤 3：添加 scripts**

`schema:generate` 固定为 `bun scripts/generate.ts`；生成器以 package root 为 cwd-independent 基准，禁止使用调用者 cwd 或绝对 path 写入内容。

- [ ] **步骤 4：验证重复生成**

测试在两个临时目录各生成两次并比较 SHA-256 和逐 byte 内容；并发启动两个生成进程时一个持锁完成、另一个等待后生成同样 bytes，不得交错输出。另写 3 个锁恢复测试：活跃锁不可抢占、同机超时且 PID 不存活的锁可 quarantine 后恢复、无法解析的锁安全失败。再运行正式生成两次，第二次 `git diff --exit-code -- packages/schema/generated packages/schema/swift-fixture/Sources` 必须无变化。

- [ ] **步骤 5：完整验证与中间提交**

运行 generate、test、lint、typecheck、build、Swift `swiftc -typecheck swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift`、format、diff check。主代理检查 lock ownership、失败恢复、无共享 mutable registry 和生成竞态；最后修正未提交。

## 0B-8 Gate

- 四类 artifact 均由同一 Zod registry 生成；
- 连续运行和不同临时目录输出 byte-for-byte 相同；
- 不支持的 Zod 节点显式失败，不产生宽松 `{}`；
- Swift artifact 可 typecheck，TypeScript artifact 可 typecheck；
- 无第二份手写领域模型、无并发写竞态或半生成状态；
- 全部验证通过后停止，等待用户验收。
