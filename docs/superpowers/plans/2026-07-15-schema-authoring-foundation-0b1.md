# Schema Authoring Foundation 0B-1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 只完成 0B-1：将 `@colorful-code/schema` 建立为按领域拆分、可从包子路径导入、barrel 可构建的 Zod 契约 authoring foundation，并停在用户验收 Gate 前。

**架构：** `src/index.ts` 仅作为公共 barrel；现有 health Zod schema 移入 `common.ts`，其余领域文件先建立无公共模型的 authoring 入口。`package.json` 显式发布每个领域子路径，结构测试从包名导入全部入口，防止后续重构造成入口漂移。0B-1 不定义 ID、枚举、Thread/Run 资源、命令、事件或生成器。

**技术栈：** TypeScript 5.9、Zod 4、Bun test、pnpm、ES modules

---

## 文件结构

- 创建 `packages/schema/src/common.ts`：承接既有 health Zod schema，建立 common authoring 入口。
- 创建 `packages/schema/src/ids.ts`：ID authoring 空入口，具体类型延后到 0B-2。
- 创建 `packages/schema/src/enums.ts`：公共枚举 authoring 空入口，具体枚举延后到 0B-2。
- 创建 `packages/schema/src/thread.ts`：Thread 公共资源 authoring 空入口。
- 创建 `packages/schema/src/run.ts`：Run 公共资源 authoring 空入口。
- 创建 `packages/schema/src/queue.ts`：Queue 公共资源 authoring 空入口。
- 创建 `packages/schema/src/operations.ts`：Operation/Approval authoring 空入口。
- 创建 `packages/schema/src/commands.ts`：Command/Query authoring 空入口。
- 创建 `packages/schema/src/ack.ts`：Ack authoring 空入口。
- 创建 `packages/schema/src/errors.ts`：Error authoring 空入口。
- 创建 `packages/schema/src/events.ts`：Event authoring 空入口。
- 创建 `packages/schema/src/snapshot.ts`：Snapshot authoring 空入口。
- 创建 `packages/schema/src/auth.ts`：Auth authoring 空入口。
- 创建 `packages/schema/src/config.ts`：Config authoring 空入口。
- 创建 `packages/schema/src/policy.ts`：Policy authoring 空入口。
- 修改 `packages/schema/src/index.ts`：移除内联 schema，仅 re-export 领域入口。
- 修改 `packages/schema/package.json`：增加 15 个领域子路径 export；root export 对应 `index`，并增加 schema package test 命令。
- 创建 `packages/schema/test/domain-entrypoints.test.ts`：验证 root 与全部包子路径可加载，既有 health contract 保持兼容。

### 任务 1：用失败测试锁定领域入口

**文件：**

- 创建：`packages/schema/test/domain-entrypoints.test.ts`
- 修改：`packages/schema/package.json`

- [x] **步骤 1：编写失败的领域入口测试**

测试静态导入 `@colorful-code/schema`，并逐一动态导入 `@colorful-code/schema/common`、`ids`、`enums`、`thread`、`run`、`queue`、`operations`、`commands`、`ack`、`errors`、`events`、`snapshot`、`auth`、`config`、`policy`。断言每个 import 返回 module object，并断言 root 的 `healthResponseSchema` 接受 `{ status: 'ok' }`、拒绝其他 status。

- [x] **步骤 2：增加测试命令并确认红灯**

在 `packages/schema/package.json` scripts 中增加：

```json
"test": "bun test test"
```

运行：`pnpm --filter @colorful-code/schema test`

预期：FAIL，错误明确指出领域子路径尚未由 package exports 提供。

### 任务 2：建立领域 authoring 文件和包出口

**文件：**

- 创建：`packages/schema/src/common.ts`
- 创建：`packages/schema/src/ids.ts`
- 创建：`packages/schema/src/enums.ts`
- 创建：`packages/schema/src/thread.ts`
- 创建：`packages/schema/src/run.ts`
- 创建：`packages/schema/src/queue.ts`
- 创建：`packages/schema/src/operations.ts`
- 创建：`packages/schema/src/commands.ts`
- 创建：`packages/schema/src/ack.ts`
- 创建：`packages/schema/src/errors.ts`
- 创建：`packages/schema/src/events.ts`
- 创建：`packages/schema/src/snapshot.ts`
- 创建：`packages/schema/src/auth.ts`
- 创建：`packages/schema/src/config.ts`
- 创建：`packages/schema/src/policy.ts`
- 修改：`packages/schema/src/index.ts`
- 修改：`packages/schema/package.json`

- [x] **步骤 1：迁移既有 health contract**

将 `healthResponseSchema` 与由 `z.infer` 得到的 `HealthResponse` 移至 `common.ts`。`index.ts` 不再直接 author schema，只从 `common` 及其他领域入口 re-export。

- [x] **步骤 2：建立其余空 authoring 入口**

每个尚未进入定义阶段的文件只包含领域职责注释与 `export {};`。不得提前添加 0B-2 的 ID、枚举、revision 或 cursor schema，也不得添加 0B-3 及之后的公共资源。

- [x] **步骤 3：发布显式包子路径**

在 package `exports` 中保留 root，并为每个领域文件增加 `./<domain>: ./src/<domain>.ts`。exports key 使用稳定字典序，避免隐式 wildcard 暴露未来内部文件。

- [x] **步骤 4：确认绿灯**

运行：`pnpm --filter @colorful-code/schema test`

预期：所有 domain entrypoint tests PASS。

运行：`pnpm --filter @colorful-code/schema typecheck`

预期：TypeScript exit 0。

运行：`pnpm --filter @colorful-code/schema build`

预期：TypeScript build exit 0，declaration 生成成功。

### 任务 3：0B-1 范围与安全审查

**文件：**

- 检查：`packages/schema/src/*.ts`
- 检查：`packages/schema/test/domain-entrypoints.test.ts`
- 检查：`packages/schema/package.json`

- [x] **步骤 1：规格合规审查**

逐项确认 16 个入口均存在；`index.ts` 只做 re-export；没有手写第二套 TypeScript model；没有进入 0B-2；没有新增 0C 的 Controller、持久化、runtime 或 credential 实现。

- [x] **步骤 2：代码质量与并发安全审查**

确认模块初始化无可变全局 registry、锁或异步副作用；包 exports 不使用 wildcard；领域入口之间无循环依赖；测试不依赖执行顺序或共享可变状态。由于本阶段只有纯 schema 模块入口，不应引入锁；若出现锁或 mutable singleton，视为阻断问题并移除。

- [x] **步骤 3：中间提交**

只暂存 0B-1 实现与测试文件，提交一次可回退的基础实现。不得暂存用户已有文档改动。

- [x] **步骤 4：主代理最终复核并保留未提交交接改动**

主代理独立检查中间提交后的 diff、运行完整验证，并针对发现的问题做最后修正。最后修正不提交，保持在分支工作区供用户 review 和手动提交。若没有需要修正的代码，也至少将本计划的完成勾选保留为未提交变更，确保最后一次交接不创建 commit。

## 0B-1 Gate

只有以下条件同时满足才交给用户验收：

- 16 个指定入口存在：15 个领域子路径可导入，root export 对应 `index`；
- root barrel 可构建，health contract 向后兼容；
- schema package test、typecheck、build 均 exit 0；
- 无 mutable global、锁、竞态入口、循环依赖或 wildcard export；
- Git diff 只包含 0B-1 范围和用户原有改动；
- 分支上存在中间实现 commit，最后 review 修正保持未提交；
- 未创建任何 0B-2 类型或 0C 实现。
