# Phase -1 安全冻结与基线实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 冻结 Colorful Code 1.x 功能边界，建立可重复的测试与数据库备份基线，并关闭 Phase -1 点名的安全和数据损坏风险。

**架构：** 保留现有 1.x `SessionStore` 和 Schema，不提前引入 Phase 0A。通过独立 fixture/backup 工具、纯函数安全边界、确定性 barrier 测试和默认关闭的 `v2` 模块入口建立可审计基线。

**技术栈：** TypeScript 5.9、Bun 1.3、Node.js test runner、NestJS 11、Drizzle ORM、`bun:sqlite`、Next.js 16、Tauri 2、GitHub Actions。

---

## 文件结构

**新增文件：**

- `docs/maintenance/1.x-freeze.md`：记录 1.x 允许与禁止的变更类型。
- `apps/server/src/v2/v2-boundary.ts`：默认关闭且不导入 1.x persistence 的 2.0 模块边界。
- `apps/server/test/v2-boundary.test.ts`：验证 flag 默认关闭及无双写依赖。
- `apps/server/test/fixtures/legacy-v1/schema.sql`：当前生产 SQLite Schema manifest。
- `apps/server/test/fixtures/legacy-v1/session-snapshot.json`：无秘密的 1.x snapshot golden fixture。
- `apps/server/test/fixtures/legacy-v1/api-responses.json`：当前 REST 响应 golden fixture。
- `apps/server/scripts/create-legacy-fixture.ts`：从固定输入创建 legacy fixture 数据库。
- `apps/server/scripts/backup-database.ts`：使用 `VACUUM INTO` 创建一致性备份及 manifest。
- `apps/server/test/legacy-baseline.test.ts`：验证 Schema、snapshot、API fixture 和可重复生成。
- `apps/server/test/database-backup.test.ts`：验证备份成功与失败路径。
- `apps/web/app/agent/model-config-storage.ts`：只序列化非敏感模型偏好的纯函数。
- `apps/web/test/agent-model-config-storage.test.ts`：验证旧秘密清理和持久化脱敏。
- `packages/tool-runtime/src/__tests__/helpers/deferred.ts`：确定性 deferred/barrier 测试辅助函数。

**修改文件：**

- `package.json`、`turbo.json`、`.github/workflows/ci.yml`、`apps/desktop/package.json`：统一测试入口和 CI 测试门禁。
- `.gitignore`：忽略本机数据库备份目录，但保留测试 fixture。
- `apps/server/test/session-restore.e2e.test.ts`：用当前真实 restore shape 修复 2 个基线漂移。
- `apps/server/src/model/model-config.ts`、`apps/server/src/sessions/model-factory.ts`：禁止服务端凭据跟随 endpoint override。
- `apps/server/test/model-selection.test.ts`、`apps/server/test/models-service.test.ts`：覆盖 preset override 外送路径。
- `packages/tool-runtime/src/core/permissions.ts`、`packages/tool-runtime/src/__tests__/permissions.test.ts`：将 blocked MCP 提升为安全 ceiling。
- `packages/tool-runtime/src/session/session.ts`、`packages/tool-runtime/src/__tests__/session.test.ts`：恢复 permission context，串行 submit 和 compaction。
- `apps/server/src/sessions/sessions.service.ts`、`apps/server/test/session-model-config.test.ts`、`apps/server/test/mcp-productization.e2e.test.ts`：传入恢复权限、修复模型替换和 audit retry。
- `apps/server/src/persistence/session-store.ts`、`apps/server/test/session-store.test.ts`：hard delete 原子化并支持故障注入测试。
- `apps/web/app/agent/page.tsx`、`apps/web/test/agent-page-source.test.ts`：移除浏览器长期秘密存储。
- `apps/server/src/config/environment.ts`、`apps/server/test/environment.test.ts`：解析默认关闭的 2.0 flag。

### 任务 1：建立绿色主干测试入口

**文件：**

- 修改：`apps/server/test/session-restore.e2e.test.ts`
- 修改：`package.json`
- 修改：`turbo.json`
- 修改：`.github/workflows/ci.yml`
- 修改：`apps/desktop/package.json`

- [x] **步骤 1：把 restore 当前响应写成明确断言**

将两个失败断言补齐当前协议字段，例如：

```ts
assert.deepEqual(restoreRes.json(), {
  id,
  needsModelConfig: false,
  history: [
    { role: 'user', content: 'first message' },
    { role: 'assistant', content: `created live session ${id}` },
  ],
  permissionMode: 'default',
});
```

- [x] **步骤 2：运行 Server 测试确认基线从 2 fail 变为全绿**

运行：`pnpm --filter @colorful-code/server test`

预期：`105 pass, 0 fail`。

- [x] **步骤 3：添加统一测试脚本**

在根 `package.json` 增加：

```json
"test": "pnpm run test:runtime && pnpm run test:server && pnpm run test:web && pnpm run test:cli",
"test:runtime": "pnpm --filter @colorful-code/tool-runtime test",
"test:server": "pnpm --filter @colorful-code/server test",
"test:web": "bun test ./apps/web/test",
"test:cli": "bun test ./apps/cli/test"
```

在 `turbo.json` 增加非缓存 `test` task；在 Desktop package 增加：

```json
"test": "cargo test --manifest-path src-tauri/Cargo.toml"
```

- [x] **步骤 4：让 CI 实际运行测试**

Quality job 安装 Bun 后运行 `pnpm test`；Desktop job 在 `cargo check` 后运行：

```yaml
- name: Test desktop crate
  run: pnpm --filter @colorful-code/desktop test
```

- [x] **步骤 5：验证统一入口**

运行：`pnpm test`

预期：Runtime、Server、Web、CLI 全部通过。

- [ ] **步骤 6：Commit**

```bash
git add package.json turbo.json .github/workflows/ci.yml apps/desktop/package.json apps/server/test/session-restore.e2e.test.ts
git commit -m "test(基线): 建立统一主干测试入口"
```

### 任务 2：固化 1.x Schema、Snapshot 和 API fixture

**文件：**

- 创建：`apps/server/test/fixtures/legacy-v1/schema.sql`
- 创建：`apps/server/test/fixtures/legacy-v1/session-snapshot.json`
- 创建：`apps/server/test/fixtures/legacy-v1/api-responses.json`
- 创建：`apps/server/scripts/create-legacy-fixture.ts`
- 创建：`apps/server/test/legacy-baseline.test.ts`
- 修改：`apps/server/package.json`

- [x] **步骤 1：先写 Schema 与 JSON fixture 失败测试**

测试读取 fixture，打开临时数据库并比较规范化后的 `sqlite_schema`：

```ts
const actual = raw
  .query("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
  .all();
assert.deepEqual(actual, expectedSchemaObjects);
assert.equal(raw.query('PRAGMA integrity_check').get()?.integrity_check, 'ok');
assert.deepEqual(JSON.parse(snapshotText), expectedSnapshot);
```

同时验证 `JSON.stringify` 后不包含 `apiKey`、`token`、`secret`。

- [x] **步骤 2：运行测试验证 fixture 尚不存在**

运行：`bun test apps/server/test/legacy-baseline.test.ts`

预期：FAIL，报错指向缺少的 `legacy-v1` fixture 或 generator。

- [x] **步骤 3：实现确定性 fixture generator**

导出纯入口：

```ts
export function createLegacyFixture(outputPath: string): void {
  const raw = new Database(outputPath, { create: true });
  raw.exec(readFileSync(schemaPath, 'utf8'));
  raw.transaction(() => {
    insertFixedSession(raw);
    insertFixedCheckpoint(raw);
    insertFixedAudit(raw);
    insertFixedProjectMetadata(raw);
    insertFixedPlugin(raw);
  })();
  raw.close();
}
```

所有 ID、时间戳和测试路径使用固定值；脚本支持 `bun .../create-legacy-fixture.ts <output>`。

- [x] **步骤 4：验证重复创建逻辑内容一致**

测试分别生成 2 个数据库，比较各业务表的排序查询结果、Schema 和 `integrity_check`，而不是比较 SQLite 二进制字节。

运行：`bun test apps/server/test/legacy-baseline.test.ts`

预期：PASS。

- [x] **步骤 5：添加 fixture 命令并验证**

在 Server package 增加：

```json
"fixture:legacy": "bun scripts/create-legacy-fixture.ts"
```

运行：`pnpm --filter @colorful-code/server fixture:legacy -- /tmp/colorful-code-legacy-v1.db`

预期：生成数据库，`integrity_check` 为 `ok`。

- [ ] **步骤 6：Commit**

```bash
git add apps/server/package.json apps/server/scripts/create-legacy-fixture.ts apps/server/test/legacy-baseline.test.ts apps/server/test/fixtures/legacy-v1
git commit -m "test(持久化): 固化 1.x 数据与协议基线"
```

### 任务 3：实现 SQLite 一致性备份

**文件：**

- 创建：`apps/server/scripts/backup-database.ts`
- 创建：`apps/server/test/database-backup.test.ts`
- 修改：`apps/server/package.json`
- 修改：`.gitignore`

- [x] **步骤 1：先写备份行为失败测试**

覆盖：WAL 源库快照含最新提交、目标 `integrity_check = ok`、manifest 哈希匹配、已存在目标拒绝覆盖、损坏源返回失败。

```ts
const result = backupDatabase({ sourcePath, outputDirectory, now: fixedNow });
assert.equal(result.integrityCheck, 'ok');
assert.equal(result.foreignKeyViolations, 0);
assert.equal(sha256(readFileSync(result.databasePath)), result.sha256);
```

- [x] **步骤 2：运行测试验证缺少实现**

运行：`bun test apps/server/test/database-backup.test.ts`

预期：FAIL，无法导入 `backupDatabase`。

- [x] **步骤 3：实现最小一致性快照流程**

核心流程：

```ts
source.query('PRAGMA quick_check').get();
source.exec(`VACUUM INTO '${escapeSqlitePath(tempDatabasePath)}'`);
const backup = new Database(tempDatabasePath, { readonly: true });
const integrity = backup.query('PRAGMA integrity_check').get();
const foreignKeys = backup.query('PRAGMA foreign_key_check').all();
```

通过临时名称写数据库与 JSON manifest；全部检查通过后再 `renameSync` 发布。目标存在或任一步失败时抛错，不覆盖旧备份。

- [x] **步骤 4：添加 CLI 与忽略规则**

Server package 增加：

```json
"db:backup": "bun scripts/backup-database.ts"
```

`.gitignore` 增加 `.backups/` 和 `data/backups/`。

- [x] **步骤 5：运行备份测试**

运行：`bun test apps/server/test/database-backup.test.ts`

预期：全部通过，且失败用例不留下最终文件。

- [ ] **步骤 6：Commit**

```bash
git add .gitignore apps/server/package.json apps/server/scripts/backup-database.ts apps/server/test/database-backup.test.ts
git commit -m "feat(备份): 添加 SQLite 一致性快照工具"
```

### 任务 4：停止浏览器长期持久化 API key

**文件：**

- 创建：`apps/web/app/agent/model-config-storage.ts`
- 创建：`apps/web/test/agent-model-config-storage.test.ts`
- 修改：`apps/web/app/agent/page.tsx`
- 修改：`apps/web/test/agent-page-source.test.ts`

- [x] **步骤 1：先写脱敏与旧数据清理失败测试**

```ts
const loaded = loadPersistedModelPreferences(JSON.stringify({
  presetId: 'openai',
  presetApiKeys: { openai: 'server-secret' },
  customApiKey: 'custom-secret',
  customBaseURL: 'http://localhost:11434/v1',
}));
assert.equal(loaded.presetId, 'openai');
assert.equal(loaded.customBaseURL, 'http://localhost:11434/v1');
assert.doesNotMatch(JSON.stringify(loaded), /server-secret|custom-secret/);
```

源码测试断言 `page.tsx` 不再把 `presetApiKeys` 或 `customApiKey` 放入 `localStorage` payload。

- [x] **步骤 2：运行测试确认旧实现失败**

运行：`bun test apps/web/test/agent-model-config-storage.test.ts apps/web/test/agent-page-source.test.ts`

预期：FAIL，序列化结果仍含秘密或纯函数不存在。

- [x] **步骤 3：提取非敏感存储模型**

```ts
export type PersistedModelPreferences = {
  presetId: string;
  presetModelOverrides: Record<string, string>;
  customProtocol: ModelProtocol;
  customBaseURL: string;
  customModel: string;
};
```

加载旧 JSON 时只挑选上述白名单字段；API key state 从空值初始化，只存在 React 内存。

- [x] **步骤 4：验证秘密不再持久化**

运行：`bun test apps/web/test/agent-model-config-storage.test.ts apps/web/test/agent-page-source.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/agent/model-config-storage.ts apps/web/app/agent/page.tsx apps/web/test/agent-model-config-storage.test.ts apps/web/test/agent-page-source.test.ts
git commit -m "fix(凭据): 停止浏览器长期存储 API key"
```

### 任务 5：封死 named preset 的服务端凭据外送

**文件：**

- 修改：`apps/server/src/sessions/model-factory.ts`
- 修改：`apps/server/test/model-selection.test.ts`
- 修改：`apps/server/test/models-service.test.ts`

- [x] **步骤 1：先写服务端 key + override 拒绝测试**

```ts
assert.throws(
  () => resolveModelClientConfig(env({ openai: 'server-secret' }), {
    preset: 'openai',
    baseURL: 'https://attacker.invalid/v1',
  }),
  (error) => error instanceof ModelSelectionError && /endpoint override/.test(error.message),
);
```

另写正例：相同 override 在携带请求级 `apiKey` 时允许；`custom` preset 不受影响。ModelsService 测试的 fetcher 必须证明拒绝发生在网络调用前。

- [x] **步骤 2：运行测试确认漏洞存在**

运行：`bun test apps/server/test/model-selection.test.ts apps/server/test/models-service.test.ts`

预期：FAIL，当前配置指向攻击地址并携带 `server-secret`。

- [x] **步骤 3：让 key 解析返回来源并实施约束**

```ts
type ResolvedApiKey = { value: string; source: 'request' | 'server' };

if (
  key.source === 'server' &&
  preset.id !== 'custom' &&
  (selection.baseURL !== undefined || selection.protocol !== undefined)
) {
  throw new ModelSelectionError(
    'Named presets using server credentials do not allow protocol or endpoint override.',
  );
}
```

`resolveModelClientConfig` 仍是 `/models/test`、`/models/list` 和 Session 的唯一解析入口。

- [x] **步骤 4：运行聚焦测试**

运行：`bun test apps/server/test/model-selection.test.ts apps/server/test/models-service.test.ts`

预期：PASS，错误文本不含真实 key。

- [ ] **步骤 5：Commit**

```bash
git add apps/server/src/sessions/model-factory.ts apps/server/test/model-selection.test.ts apps/server/test/models-service.test.ts
git commit -m "fix(模型): 禁止服务端凭据跟随端点覆盖"
```

### 任务 6：把 blocked MCP 提升为安全 ceiling 并正确恢复

**文件：**

- 修改：`packages/tool-runtime/src/core/permissions.ts`
- 修改：`packages/tool-runtime/src/__tests__/permissions.test.ts`
- 修改：`packages/tool-runtime/src/session/session.ts`
- 修改：`packages/tool-runtime/src/__tests__/session.test.ts`
- 修改：`apps/server/src/sessions/sessions.service.ts`
- 修改：`apps/server/test/mcp-productization.e2e.test.ts`

- [x] **步骤 1：先写 blocked × mode 失败矩阵**

```ts
for (const mode of PERMISSION_MODES) {
  const result = evaluatePermission(mcpTool, { path: workspaceFile }, context({
    mode,
    rules: [{ source: 'session', behavior: 'allow', toolName: mcpTool.name }],
    mcpTrust: new Map([['docs', 'blocked']]),
  }));
  assert.equal(result.behavior, 'deny', mode);
  assert.deepEqual(result.reason, { type: 'mcpTrust', server: 'docs', trust: 'blocked' });
}
```

- [x] **步骤 2：写 restore 保持 rules/trust 的失败测试**

扩展 `Session.restore` deps 接受 `permissionContext`，测试恢复后调用同一个 MCP tool 仍 deny，并验证显式 deny rule 仍生效。

- [x] **步骤 3：运行测试确认 plan/readOnly/bypass 等路径错误放行**

运行：`pnpm --filter @colorful-code/tool-runtime test`

预期：新增矩阵失败。

- [x] **步骤 4：实现 ceiling 顺序与恢复注入**

在 `evaluatePermission()` 最前面解析 MCP server；若 trust 为 `blocked`，在 `bypass` 之前返回 deny。普通 `trusted`/`ask` 仍在便捷 mode 和规则之后按现有语义处理。

`Session.restore` 使用调用方传入的 permission context，并用 snapshot 的 mode/workspace roots 覆盖历史投影字段：

```ts
permissionContext: {
  ...deps.permissionContext,
  mode: snapshot.permissionMode,
  workspaceRoots: [...snapshot.workspaceRoots],
  rules: [...(deps.permissionContext?.rules ?? [])],
}
```

Server 的两个 restore 构造路径传入 `buildRestoredPermissionContext()` 的结果。

- [x] **步骤 5：运行 Runtime 与 Server MCP 测试**

运行：`pnpm --filter @colorful-code/tool-runtime test`

运行：`bun test apps/server/test/mcp-productization.e2e.test.ts apps/server/test/session-restore.e2e.test.ts`

预期：全部通过，audit reason 保持 `mcpTrust/blocked`。

- [ ] **步骤 6：Commit**

```bash
git add packages/tool-runtime/src/core/permissions.ts packages/tool-runtime/src/session/session.ts packages/tool-runtime/src/__tests__/permissions.test.ts packages/tool-runtime/src/__tests__/session.test.ts apps/server/src/sessions/sessions.service.ts apps/server/test/mcp-productization.e2e.test.ts
git commit -m "fix(权限): 将 blocked MCP 设为安全上限"
```

### 任务 7：确定性串行化 submit 与 manual compaction

**文件：**

- 创建：`packages/tool-runtime/src/__tests__/helpers/deferred.ts`
- 修改：`packages/tool-runtime/src/session/session.ts`
- 修改：`packages/tool-runtime/src/__tests__/session.test.ts`

- [x] **步骤 1：添加无定时器 deferred helper**

```ts
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

- [x] **步骤 2：先写 3 submit 的 barrier 失败测试**

第 1 个 model run 等待 barrier；同时提交 2、3。释放 barrier 后断言用户消息顺序为 `one, two, three`，每一轮看到的 history 单调增长，且 model 最大并发为 1。

- [x] **步骤 3：运行测试确认旧 activeRun 窗口导致并发**

运行：`pnpm --filter @colorful-code/tool-runtime test`

预期：新增测试 FAIL，最大并发大于 1 或 history 交错。

- [x] **步骤 4：用尾 Promise 串行 submit**

```ts
private submitTail: Promise<void> = Promise.resolve();

submit(text: string): Promise<void> {
  const submitted = this.submitTail.then(() => this.runSubmit(text));
  this.submitTail = submitted.catch(() => undefined);
  return submitted;
}
```

把当前实现移动到私有 `runSubmit()`；单次失败不能毒死后续队列。

- [x] **步骤 5：先写双 compact 与 compact + submit 失败测试**

使用两个 compaction barrier，触发两次 `compact` 并插入 submit；断言最多一个 compaction 运行，第二次发出明确 skipped 事件，旧 compaction 结果不会覆盖新消息。

- [x] **步骤 6：实现 manual compaction gate**

新增 `manualCompaction?: Promise<void>`。已有 compaction 时立即发出：

```ts
{
  type: 'context_compaction_skipped',
  runId,
  reason: 'Context compaction is already running.',
}
```

compaction 在 `submitTail` 完成后读取 history，并在 `finally` 清 gate。

- [x] **步骤 7：运行 Runtime 全测**

运行：`pnpm --filter @colorful-code/tool-runtime test`

预期：全部通过，无依赖人为 sleep 的新增竞态测试。

- [ ] **步骤 8：Commit**

```bash
git add packages/tool-runtime/src/session/session.ts packages/tool-runtime/src/__tests__/session.test.ts packages/tool-runtime/src/__tests__/helpers/deferred.ts
git commit -m "fix(会话): 串行提交并隔离手动压缩"
```

### 任务 8：修复实际模型替换

**文件：**

- 修改：`apps/server/src/sessions/sessions.service.ts`
- 修改：`apps/server/test/session-model-config.test.ts`

- [x] **步骤 1：先写已配置 Session 的模型切换失败测试**

工厂按 selection 返回两个带不同输出的 model。创建后配置第二个 model，再 submit，断言只出现第二个输出且 factory 仅为 configure 构建一次 client。

- [x] **步骤 2：运行测试确认配置成功但仍使用旧 model**

运行：`bun test apps/server/test/session-model-config.test.ts`

预期：FAIL，输出仍来自旧 model。

- [x] **步骤 3：让所有 live Session 从一开始持有 swappable wrapper**

创建/恢复时统一以 `SwappableModelClient` 包装实际 client。`configureModel()` 只构建一次：

```ts
const model = this.tryBuildModelClient(id, selection);
if (!model) return { needsModelConfig: true };
entry.swappableModel.swap(model);
entry.needsModelConfig = false;
return { needsModelConfig: false };
```

- [x] **步骤 4：运行模型配置与 restore 测试**

运行：`bun test apps/server/test/session-model-config.test.ts apps/server/test/session-restore.e2e.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/server/src/sessions/sessions.service.ts apps/server/test/session-model-config.test.ts
git commit -m "fix(会话): 使模型切换作用于实际客户端"
```

### 任务 9：原子化 hard delete 并保留失败 audit

**文件：**

- 修改：`apps/server/src/persistence/session-store.ts`
- 修改：`apps/server/src/sessions/sessions.service.ts`
- 修改：`apps/server/test/session-store.test.ts`
- 修改：`apps/server/test/session-model-config.test.ts`

- [x] **步骤 1：先写 delete 中途失败回滚测试**

为 `SessionStore.openAt()` 增加仅测试使用的可选 fault hook：

```ts
type SessionStoreFaultHooks = { afterDeleteAudit?: () => void };
```

插入四类关联记录，hook 抛错，断言 session、checkpoint、audit、metadata 全部仍存在。

- [x] **步骤 2：运行测试确认当前 autocommit 留下部分删除**

运行：`bun test apps/server/test/session-store.test.ts`

预期：FAIL，audit 已删除而其他表仍在。

- [x] **步骤 3：使用当前连接 transaction 包裹多表删除**

```ts
this.handle.raw.transaction(() => {
  this.db.delete(audit).where(...).run();
  this.faultHooks.afterDeleteAudit?.();
  this.db.delete(checkpoints).where(...).run();
  this.db.delete(sessionMetadata).where(...).run();
  this.db.delete(sessions).where(...).run();
})();
```

`deleteSessions` 使用同样原子边界。

- [x] **步骤 4：先写 audit append 失败重试测试**

注入第一次 `appendAudit` 抛错、第二次成功。触发两次 persist，断言最终 audit 恰好 1 条。

- [x] **步骤 5：修复先 splice 后写入的问题**

```ts
const batch = pendingAudit.slice();
this.store.appendAudit(session.id, batch);
pendingAudit.splice(0, batch.length);
```

catch 记录脱敏错误，保留 pending batch；只有 append 成功才确认删除。

- [x] **步骤 6：运行持久化聚焦测试**

运行：`bun test apps/server/test/session-store.test.ts apps/server/test/session-model-config.test.ts`

预期：PASS，失败注入后可重试且不丢记录。

- [ ] **步骤 7：Commit**

```bash
git add apps/server/src/persistence/session-store.ts apps/server/src/sessions/sessions.service.ts apps/server/test/session-store.test.ts apps/server/test/session-model-config.test.ts
git commit -m "fix(持久化): 原子删除并保留失败审计"
```

### 任务 10：建立冻结规则和默认关闭的 2.0 边界

**文件：**

- 创建：`docs/maintenance/1.x-freeze.md`
- 创建：`apps/server/src/v2/v2-boundary.ts`
- 创建：`apps/server/test/v2-boundary.test.ts`
- 修改：`apps/server/src/config/environment.ts`
- 修改：`apps/server/test/environment.test.ts`
- 修改：`apps/server/.env.example`

- [x] **步骤 1：先写 flag 与依赖边界失败测试**

```ts
assert.equal(loadServerEnvironment({ NODE_ENV: 'test' }).v2Enabled, false);
assert.equal(loadServerEnvironment({ NODE_ENV: 'test', COLORFUL_CODE_V2_ENABLED: 'true' }).v2Enabled, true);
```

源码边界测试读取 `apps/server/src/v2` 下的 `.ts` 文件，断言不包含 `/persistence/session-store`、`SessionStore` 或 1.x 表写入。

- [x] **步骤 2：运行测试确认配置字段不存在**

运行：`bun test apps/server/test/environment.test.ts apps/server/test/v2-boundary.test.ts`

预期：FAIL，`v2Enabled` 不存在。

- [x] **步骤 3：实现严格布尔解析与无副作用边界**

```ts
export type V2Boundary = { enabled: boolean; persistenceOwner: 'none' };

export function createV2Boundary(enabled: boolean): V2Boundary {
  return { enabled, persistenceOwner: 'none' };
}
```

环境变量只接受 `true`/`false`，默认 `false`。本阶段不把边界注册到 Nest，不创建路由、后台任务或数据库连接。

- [x] **步骤 4：编写冻结维护说明**

文档明确 Web/Tauri 允许安全、稳定、测试、构建、兼容修复；禁止新增体验功能。2.0 新代码只能进入独立边界，禁止双写。

- [x] **步骤 5：运行配置和边界测试**

运行：`bun test apps/server/test/environment.test.ts apps/server/test/v2-boundary.test.ts`

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add docs/maintenance/1.x-freeze.md apps/server/src/v2/v2-boundary.ts apps/server/test/v2-boundary.test.ts apps/server/src/config/environment.ts apps/server/test/environment.test.ts apps/server/.env.example
git commit -m "chore(边界): 冻结 1.x 并隔离 2.0 模块"
```

### 任务 11：生成当前数据库备份并完成 Phase -1 验收

**文件：**

- 修改：`docs/superpowers/plans/2026-07-10-phase-minus-one-safety-freeze.md`（勾选执行状态）
- 生成但不提交：`.backups/<timestamp>/colorful-code.db`
- 生成但不提交：`.backups/<timestamp>/manifest.json`

- [ ] **步骤 1：确认源数据库路径**

按 Server 默认配置优先检查 `data/colorful-code.db`；如果 `DATABASE_PATH` 明确设置，则使用该路径。不得把 `apps/server/data` 和根 `data` 猜测性合并。

- [ ] **步骤 2：执行一致性备份**

运行：

```bash
pnpm --filter @colorful-code/server db:backup -- data/colorful-code.db .backups
```

预期：输出 backup 数据库、manifest、`integrity_check: ok`、foreign key violation `0` 和 SHA-256。

- [ ] **步骤 3：执行完整自动化验证**

依次运行：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm --filter @colorful-code/desktop test
```

预期：全部退出码为 0，没有测试失败、TypeScript 错误或 lint error。

- [ ] **步骤 4：执行安全边界静态复核**

运行：

```bash
rg -n "presetApiKeys|customApiKey" apps/web/app/agent
rg -n "SessionStore|persistence/session-store" apps/server/src/v2
git diff --check
```

预期：API key 只出现在内存 state/请求构造，不出现在持久化 payload；`v2` 无 1.x store 导入；diff 无空白错误。

- [ ] **步骤 5：逐项对照规格验收标准**

核对设计规格第 10 节的 10 项标准。任何未满足项必须报告为未完成，不得以测试部分通过替代。

- [ ] **步骤 6：Commit**

```bash
git add docs/superpowers/plans/2026-07-10-phase-minus-one-safety-freeze.md
git commit -m "docs(安全基线): 记录 Phase -1 验收结果"
```

备份数据库和 manifest 保持忽略，不加入 Git。
