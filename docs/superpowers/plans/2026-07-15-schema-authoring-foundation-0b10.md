# Schema Authoring Foundation 0B-10 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现。只有 0B-9 经用户验收后才能执行；完成后停在最终 0B Gate，不进入 0C。

**目标：** 建立本地与 CI 共用的生成漂移、TypeScript/Swift conformance、旧术语、内部 Runtime 类型和 secret 边界 Gate，冻结公共契约。

**架构：** `gate:0b` 是单一编排入口，按固定顺序调用已有生成/检查命令。漂移检查只观察受管路径；CI 在 clean checkout 上执行并要求零 diff。每个子检查独立可运行，失败保留具体诊断。

**技术栈：** pnpm/Bun、Git、Swift Package Manager、GitHub Actions

---

## 受管路径

- `packages/schema/src`
- `packages/schema/generated`
- `packages/schema/fixtures/golden`
- `packages/schema/swift-fixture`
- `packages/schema/scripts`
- `packages/schema/test`
- `packages/schema/package.json`

### 任务 1：生成漂移与确定性检查

**文件：** `packages/schema/scripts/check-generated-drift.ts`、`packages/schema/package.json`、`packages/schema/test/generated-drift.test.ts`

- [ ] **步骤 1：写漂移 checker 红灯测试**

在临时 git fixture 中覆盖四种情况：clean generation pass；修改 generated file fail；删除 generated file fail；新增 orphan generated file fail。诊断只列受管 relative path。

- [ ] **步骤 2：实现无破坏检查流程**

在两个独立临时目录生成并互比，再把临时输出逐 byte 对比当前 working tree 的 generated/fixture/Swift source。checker 不改 working tree、不要求 source clean，也不把用户的其他 dirty 文件算作漂移；缺失、额外或内容不同的受管输出都失败。只有 CI clean-checkout 步骤使用 Git status 断言提交无漂移，任何路径都不得 reset/checkout 用户改动。

- [ ] **步骤 3：添加 `schema:check-generated`**

命令不使用 shell-specific glob，macOS/Linux 行为一致；并发运行使用各自 mkdtemp，不共享固定 `/tmp/schema-output`。

### 任务 2：正式公共边界扫描

**文件：** `packages/schema/scripts/check-public-boundaries.ts`、`packages/schema/test/public-boundary-gate.test.ts`

- [ ] **步骤 1：汇总 vocabulary/runtime/secret denylist**

扫描范围严格限定为 2.0 受管路径：`packages/schema/src` 中的正式 registry/schema、`packages/schema/generated`、`packages/schema/swift-fixture/Sources` 和 `packages/schema/fixtures/golden/valid`。禁止 Session/Chat 作为 2.0 领域标识，禁止 RuntimeSession、Lease、worker routing、ToolExecutionAttempt、LateObservationInbox、projectionRevision，禁止 secret-bearing property。仓库其他 1.x source、兼容 adapter 和历史文档不在本 Gate 范围内。denylist/checker/invalid fixture 通过显式 path allowlist 排除，不全局跳过 test 目录。

- [ ] **步骤 2：写 mutation tests**

在临时副本分别注入旧术语、internal type、secret property、generated Swift field，checker 必须失败并报告文件/JSON path；诊断不输出 property value。

- [ ] **步骤 3：验证 Zod 唯一 authoring source**

仅在上述 2.0 受管路径内禁止手写 `openapi.v2.yaml/json`、第二份 event schema、非 generated Swift domain model 和手写 TS interface 镜像。generated artifact 必须带固定 generated marker，且只有生成器可改写；不得因本 Gate 修改或删除合法的 1.x Session、事件和 TypeScript 类型。

### 任务 3：单一 0B Gate 命令

**文件：** `packages/schema/scripts/gate-0b.ts`、`packages/schema/package.json`

- [ ] **步骤 1：定义固定执行顺序**

严格为：无破坏 `schema:check-generated`（在临时目录重建 fixtures/artifacts、验证确定性并逐 byte 对比 working output）→ TypeScript conformance → Swift conformance → cross-language compare → schema unit test → lint → typecheck → build → format → public boundary scan。Gate 不运行写入 working tree 的正式 generate 命令，不覆盖用户正在 review 的产物。子进程使用 argument array，不拼 shell string；继承最小环境，cwd 固定 package root。

- [ ] **步骤 2：失败即停且保留阶段名**

每步打印机器稳定的 `[0B-GATE] <step>`；首个失败返回原 exit code，不吞 stderr、不继续后续步骤。设置生成/Swift 测试合理 timeout，超时先终止子进程树再失败，避免 CI 悬挂。

- [ ] **步骤 3：添加 `gate:0b`**

package script 固定 `bun scripts/gate-0b.ts`；root package 增加 `test:schema-contract` 转发命令。0B-10 不修改 `BUILD.bazel`、`bazel/run-task.sh` 或 Bazel 测试，继续保留严格的 7 个 orchestration target。若以后需要 Bazel schema-contract target，必须另立构建设计变更并单独验收。

### 任务 4：CI 集成

**文件：** `.github/workflows/ci.yml`、`package.json`

- [ ] **步骤 1：新增 schema-contract job**

使用 clean checkout、Node 22、pnpm 11.0.8、Bun 与 Swift 6 toolchain；`pnpm install --frozen-lockfile` 后直接运行 root `pnpm test:schema-contract`。job 在 quality/desktop 消费契约前完成，使用 `needs` 明确依赖；同时运行现有 `bash bazel/test/run-task.test.sh`，证明 7 目标 Bazel 契约未被改动。

- [ ] **步骤 2：CI clean diff 断言**

Gate 后额外执行 `git status --porcelain -- packages/schema/generated packages/schema/fixtures/golden packages/schema/swift-fixture/Sources` 并要求空输出。CI 不配置 auto-format/auto-commit。

- [ ] **步骤 3：失败 artifact 诊断**

只上传生成 diff、测试 result JSONL 和 Swift test log；不得上传 fixture payload 中可能模拟 credential 的 invalid 文件或环境变量。

### 任务 5：最终 0B 审查与冻结

**文件：** 检查所有受管路径及 0B-2..0B-10 计划

- [ ] **步骤 1：需求追踪矩阵**

逐条将用户 0B-1..0B-10 要求映射到 schema/test/generated artifact/CI step；任何未映射项阻断 Gate。

- [ ] **步骤 2：锁、竞态与安全专项审查**

确认 registry immutable；generator 原子串行写；临时目录 per-process；无固定 lockfile 死锁；失败不留部分输出；Gate 子进程超时可回收；secret checker 不回显值；CI 不执行 0C 服务或数据库代码。

- [ ] **步骤 3：运行两次完整 Gate**

第一次从当前 checkout 运行 `pnpm --filter @colorful-code/schema gate:0b`；第二次立即重跑。两次均须 exit 0，且运行前后受管输出的 byte hash 不变；CI clean checkout 另外要求 Git 零 diff。

- [ ] **步骤 4：中间提交与最终未提交 review 修正**

提交 CI/Gate 基础实现作为中间检查点；主代理完成最终跨阶段 review，最后修正不提交，交用户手动 review。不得创建 0C branch、Controller、数据库或运行时实现。

## 最终 0B Gate

- 四类跨端产物均可由同一 Zod source 确定性重建；
- TypeScript 与 Swift conformance 消费同一 fixtures 并一致；
- clean CI 重新生成零 diff；
- 正式契约无旧术语、内部 Runtime 类型和 secret material；
- 原子生成、并发临时目录、timeout 与失败清理通过专项审查；
- 两次完整 Gate exit 0 后停止，等待用户最终验收；绝不启动 0C。
