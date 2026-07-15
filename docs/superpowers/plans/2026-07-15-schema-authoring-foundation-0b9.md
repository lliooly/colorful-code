# Schema Authoring Foundation 0B-9 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-8 经用户验收后才能执行；完成后停在 0B-9 Gate。

**目标：** 建立 TypeScript 与 Swift 共同消费的跨语言 golden fixtures，覆盖 enum、optional/nullable、union、unknown event、64-bit cursor、Ack/Error/Reset、credential 边界和 strict unknown-field rejection。

**架构：** fixture 数据只有一份，位于 `packages/schema/fixtures/golden`；manifest 指定 schema、输入文件和 expected outcome。TypeScript 通过 Zod registry parse，Swift 通过生成的 Codable model parse。fixture 是测试数据，不是第二份 schema authoring source。

**技术栈：** Bun test、Swift Package Manager/XCTest、generated Codable models

---

## 文件结构

- 创建 `packages/schema/fixtures/golden/manifest.json`。
- 创建 `packages/schema/fixtures/golden/valid/*.json` 与 `invalid/*.json`。
- 创建 `packages/schema/scripts/generate-fixtures.ts`：只从 Zod-validated case data 写 fixture。
- 创建 `packages/schema/test/conformance.test.ts`。
- 创建 `packages/schema/swift-fixture/Package.swift`。
- 使用 `packages/schema/swift-fixture/Sources/ColorfulCodeContracts/ColorfulCodeContracts.swift`：直接消费 0B-8 生成文件，不复制、不手写。
- 创建 `packages/schema/swift-fixture/Tests/ColorfulCodeContractsTests/GoldenFixtureTests.swift`。

### 任务 1：Manifest 与完整 fixture catalog

**文件：** `packages/schema/scripts/generate-fixtures.ts`、`packages/schema/fixtures/golden/manifest.json`、fixture JSON files

- [ ] **步骤 1：定义 manifest schema 与红灯测试**

每项 strict `{ id,schema,file,expect,expectedOutcome? }`；expect 为 `accept | reject`。ID/文件唯一，路径必须留在 golden root，禁止 `..`、absolute path、symlink escape。

- [ ] **步骤 2：建立 required case matrix**

至少包含：每个 enum value；optional absent；nullable null；optional+nullable absent/null/value；所有核心 discriminated union branch；unknown non-critical durable/transient；critical unknown；cursor `9007199254740993`；CommandAck original/replayed；每个 ErrorCode ApiError；SnapshotReset with/without runtime；CredentialRef；nested secret reject；unknown top-level/nested field reject。

- [ ] **步骤 3：生成确定性 fixture**

case authoring data先经目标 Zod schema验证：expect accept 必须 parse，expect reject 必须 fail。使用与 0B-8 相同 stable JSON writer；生成两次 byte 相同。invalid secret fixture 只使用明显假值 `not-a-secret-value`，测试错误日志不得打印 value。

### 任务 2：TypeScript conformance runner

**文件：** `packages/schema/test/conformance.test.ts`、`packages/schema/package.json`

- [ ] **步骤 1：写 manifest runner 红灯测试**

从 registry 按 schema name 取 Zod schema，逐文件 JSON.parse + safeParse；actual 与 expect 必须一致。缺 schema、重复 ID、未被 manifest 引用的 fixture file、缺失 required category 均失败。

- [ ] **步骤 2：验证 unknown event outcome**

unknown non-critical expected `unknownNonCritical` 且 frame cursor 保留；critical unknown expected `resetRequired`；malformed known event expected protocolError。不能只验证 Zod parse success。

- [ ] **步骤 3：添加 `test:conformance`**

命令固定为 `bun test test/conformance.test.ts`，从任意 cwd 可运行。

### 任务 3：Swift strict Codable conformance

**文件：** `packages/schema/swift-fixture/Package.swift`、generated Swift source、`GoldenFixtureTests.swift`

- [ ] **步骤 1：建立 Swift Package**

Package 使用 Swift tools 6.0、macOS 13；generated model source 作为唯一 target model。测试通过环境变量 `SCHEMA_GOLDEN_FIXTURE_ROOT` 指向同一 golden 目录，不复制 fixture。

- [ ] **步骤 2：实现 strict unknown-key decoding**

Swift Codable 默认忽略未知字段，因此生成的每个 strict struct 必须在 init(from:) 比较 `AnyCodingKey` 与 CodingKeys.allCases，发现未知 key 抛 `DecodingError.dataCorrupted`。测试顶层与嵌套 unknown field 都 reject。

- [ ] **步骤 3：实现 optional/nullable presence tracking**

仅用 `decodeIfPresent` 无法区分缺失与 null；生成 `Presence<T>`（absent/null/value）只用于契约中同时需要 optional+nullable 的字段。Swift fixture 断言三种状态与 TypeScript 一致。

- [ ] **步骤 4：实现 union/unknown event decoding**

先检查 kind/durability；已知 branch 解码失败必须抛 protocol error，不能 fallback unknown；未知非关键保存 raw JSON/cursors；未知关键抛 typed `criticalUnknownEvent`，测试映射为 resetRequired。

### 任务 4：跨语言结果比较与安全复核

**文件：** `packages/schema/scripts/compare-conformance.ts`、`packages/schema/package.json`

- [ ] **步骤 1：输出机器可读结果**

TS 与 Swift runner 各输出按 fixture id 排序的 JSONL `{id,outcome}` 到临时目录；compare script 要求集合和 outcome 完全相等。stdout 不包含 fixture payload。

- [ ] **步骤 2：添加 `test:swift-conformance` 与 `test:cross-language`**

Swift 命令显式传 fixture root；cross-language 依次运行 TS、Swift、compare，任一非零立即失败。

- [ ] **步骤 3：完整验证与中间提交**

运行 fixture generation 两次、TS conformance、Swift conformance、cross-language compare、test、lint、typecheck、build、format、diff check。主代理检查 path traversal、并发临时文件隔离和错误日志脱敏；最终修正未提交。

## 0B-9 Gate

- required catalog 每一类均有 manifest case，无 orphan fixture；
- TypeScript 与 Swift 读取同一文件并得出完全一致 outcome；
- 64-bit cursor 在两端均为 String；
- Swift strict unknown-field、optional/nullable、known-invalid-not-unknown 行为正确；
- secret fixture 不泄漏值，manifest path 无 traversal；
- 全部验证通过后停止，等待用户验收。
