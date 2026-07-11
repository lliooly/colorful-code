# 🔍 Colorful Code — 综合代码审查报告

> 审查日期: 2026-07-06
> 审查范围: 全部代码库 (apps/server, apps/web, apps/desktop, apps/cli, packages/\*)
> 审查重点: 代码逻辑、安全性、实现方案、性能、Bug

---

## 目录

1. [🔴 严重问题 (Critical)](#-严重问题-critical)
2. [🟠 高优先级 (High)](#-高优先级-high)
3. [🟡 中等优先级 (Medium)](#-中等优先级-medium)
4. [🟢 低优先级 / 改进建议 (Low)](#-低优先级--改进建议-low)
5. [📋 逐文件问题清单](#-逐文件问题清单)
6. [📊 总结与修复优先级建议](#-总结与修复优先级建议)
7. [🧭 2026-07-10 并发、一致性与协议补充审查](#-2026-07-10-并发一致性与协议补充审查)

---

## 🔴 严重问题 (Critical)

### C1. API Key 明文存储在 localStorage

**文件:** `apps/web/app/agent/page.tsx:1161-1493`

**问题描述:**

```typescript
const MODEL_CONFIG_STORAGE_KEY = 'colorful-code.agent.model-config';
// ...
window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(config));
// config 包含: presetApiKeys (所有 preset 的 API key)、customApiKey
```

API keys 以明文形式持久化在 `localStorage` 中。任何能访问浏览器 DevTools 的 XSS 攻击、恶意浏览器扩展、或物理访问设备的人都可以直接读取这些密钥。

**影响:** API key 泄露 → 攻击者可以使用用户的密钥调用 API，产生费用或窃取数据。

**修复建议:**

- 短期: 至少在存储前用 Web Crypto API 加密，每次使用时要求用户输入主密码解密
- 长期: 使用 HttpOnly cookie + 服务端 session 管理密钥，密钥从不在客户端持久化
- 备选: 使用 Tauri 的安全存储 API (`tauri-plugin-store` 的 encrypted store）

---

### C2. Bash 命令通过 `sh -lc` 执行 — 多维度安全隐患

**文件:** `packages/tool-runtime/src/tools/bash.ts:310, 392`

**问题描述:**

```typescript
const child = spawn('sh', ['-lc', input.command], {
```

1. **`-lc` 组合极危险:**
   - `-l` (login shell): 加载 `~/.bashrc`、`~/.zshrc`、`~/.profile` 等配置文件
   - 这些配置文件中的任何代码都会被执行
   - 恶意 agent 可通过污染这些文件实现持久化后门
   - 即使用户手动审查了命令，配置文件中的代码也会静默执行

2. **没有系统级沙箱:**
   - bash 命令可以访问整个文件系统（包括 `/etc/passwd`、`~/.ssh/` 等敏感区域）
   - 可以发起任意网络请求（`curl`、`wget` 等）
   - 可以操作进程（`kill`、`ps` 等）
   - 虽然有 `workspaceRoots` 的 cwd 检查，但命令可以通过 `cd /` 方式逃逸

3. **资源限制仍不完整:**
   - `MAX_TIMEOUT_MS = 120_000` (2分钟)
   - 后台进程 (`run_in_background: true`) 也会按 `timeoutMs` 定时 `SIGTERM`
   - 但后台进程数量没有上限，且没有统一的进程组清理；命令自行 fork 出的子进程可能继续占用资源

**修复建议:**

- 移除 `-l` flag，只使用 `-c`
- 考虑在容器/沙箱中执行 bash 命令（Docker、bubblewrap、firejail）
- 使用 seccomp filter 限制可用系统调用
- 添加网络访问控制和文件系统访问控制
- 对后台进程添加数量限制，并使用进程组清理子进程

---

### C3. `files.ts` 中存在 TOCTOU (Time-of-Check-Time-of-Use) 竞态条件

**文件:** `packages/tool-runtime/src/tools/files.ts:59-80`

**问题描述:**

```typescript
async function realSandboxPath(filePath: string, depth = 0): Promise<string> {
  // Step 1: 先检查是否为符号链接
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink()) {
    const target = await readlink(filePath);
    return await realSandboxPath(resolve(dirname(filePath), target), depth + 1);
  }
  // Step 2: 时间窗口 — 攻击者可以在此刻替换路径组件为符号链接
  // Step 3: 用 realpath 解析
  return await realpath(filePath);
}
```

**问题:** `lstat`/`readlink` 检查和 `realpath` 解析之间存在时间窗口。在多进程环境下，攻击者可以通过以下方式利用:

1. 创建一个普通目录 `/tmp/safe/`
2. 在检查通过后、`realpath` 调用前，将 `/tmp/safe/` 替换为指向 `/etc/` 的符号链接
3. 路径解析会指向 `/etc/passwd` 等敏感文件

此外，`nearestExistingPath` 函数也是逐步向上查找存在的路径，每一步都可能被竞态条件利用。

**修复建议:**

- 使用 `openat()` + `O_NOFOLLOW` 进行原子化操作
- 在解析后再次验证 resolved path 是否仍在 sandbox 内
- 使用操作系统提供的沙箱机制（如 macOS 的 sandbox_init、Linux 的 landlock）

---

### C4. `configureModel` 的逻辑缺陷 — 浪费一个 model client

**文件:** `apps/server/src/sessions/sessions.service.ts:1217-1237`

**问题描述:**

```typescript
configureModel(id: string, selection: ModelSelection): { needsModelConfig: boolean } {
  const entry = this.require(id);
  if (!entry.swappableModel) {
    // 当 session 已用真实 model 创建时，swappableModel 为 undefined
    // 这里构建了第一个 model client
    const model = this.buildModelClient(id, selection);
    entry.swappableModel = new SwappableModelClient(model);
  }
  // 然后又构建了第二个 model client
  const model = this.tryBuildModelClient(id, selection);
  if (model) {
    if (entry.swappableModel) {
      entry.swappableModel.swap(model); // 用第二个 swap 掉第一个
    }
    // ...
  }
}
```

**问题分析:**

- 当 session 以已配置 model 创建时 (swappableModel = undefined):
  1. 先 `buildModelClient` → `new SwappableModelClient(model1)`
  2. 再 `tryBuildModelClient` → `swappableModel.swap(model2)`
  3. `model1` 被浪费（创建了但从未使用）
- 当 session 以未配置 model 创建时 (swappableModel 已存在):
  1. `!entry.swappableModel` 为 false → 跳过第一个 model 构建
  2. 直接 tryBuildModelClient → swap
  3. 逻辑正确，没有问题

**修复建议:**

```typescript
configureModel(id: string, selection: ModelSelection): { needsModelConfig: boolean } {
  const entry = this.require(id);
  const model = this.tryBuildModelClient(id, selection);
  if (model) {
    if (!entry.swappableModel) {
      entry.swappableModel = new SwappableModelClient(model);
    } else {
      entry.swappableModel.swap(model);
    }
    entry.needsModelConfig = false;
    return { needsModelConfig: false };
  }
  entry.needsModelConfig = true;
  return { needsModelConfig: true };
}
```

---

### C5. Concurrent `submit()` 的竞态条件

**文件:** `packages/tool-runtime/src/session/session.ts:460-545`

**问题描述:**

```typescript
async submit(text: string): Promise<void> {
  if (this.activeRun) {
    await this.activeRun.catch(() => undefined);
  }
  // <-- 此处有竞态窗口

  this.history.push({ role: 'user', content: text });
  // ...
  const run = runTurn({...});
  this.activeRun = run;  // <-- 非原子操作
  await run;
}
```

**问题:** `await this.activeRun.catch(...)` 和设置 `this.activeRun = run` 之间不是原子的。如果两个 `submit()` 几乎同时到达:

1. Thread A: `activeRun` 为 null，进入设置阶段
2. Thread B: `activeRun` 仍为 null（A 还没设置），也进入设置阶段
3. A 和 B 同时修改 `this.history`、`this.context` 等共享状态
4. 导致数据竞争、丢失消息或状态不一致

**修复建议:** 使用互斥锁或任务队列:

```typescript
private submitQueue: Promise<void> = Promise.resolve();

async submit(text: string): Promise<void> {
  this.submitQueue = this.submitQueue.then(() => this.runSubmit(text));
  return this.submitQueue;
}
```

---

### C6. LSP JSON-RPC 请求没有超时 — 语言服务器异常会卡住工具调用

**文件:** `packages/tool-runtime/src/lsp/client.ts:162-171, 388-408`

**问题描述:**

```typescript
function request(
  connection: LspClientConnection,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const id = connection.nextId++;
  writeMessage(connection, { id, method, params });
  return new Promise((resolve, reject) => {
    connection.pending.set(id, { resolve, reject });
  });
}

const result = await request(connection, 'initialize', { ... });
```

**问题:** `request()` 只把 resolver 放进 `pending`，没有超时。只要 LSP server 进程还活着但不返回响应，`initialize`、`textDocument/definition`、`textDocument/references`、`textDocument/hover` 等调用就会一直等待。

**影响:**

- 新建 session 时如果自动检测到 LSP，但语言服务器初始化卡住，session 创建会被拖住
- Agent 调用 LSP 工具时可能一直等待，用户看到的是运行中但没有结果
- `pending` Map 中的请求不会被清理，长时间运行后可能积累悬挂 promise

**修复建议:**

```typescript
const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 15_000;

function request(
  connection: LspClientConnection,
  method: string,
  params?: unknown,
  timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = connection.nextId++;
  writeMessage(connection, { id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new Error(`LSP request timed out: ${method}`));
    }, timeoutMs);
    connection.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}
```

---

## 🟠 高优先级 (High)

### H1. SSE 连接和所有 REST 端点无认证/授权

**文件:** `apps/server/src/sessions/sessions.controller.ts` (全部端点)
**文件:** `apps/server/src/plugins/plugins.controller.ts` (全部端点)
**文件:** `apps/server/src/model/models.controller.ts`

**问题描述:** 整个 API 没有任何认证机制。Session ID 是唯一的"认证"凭据，但它是可预测的（见 H2）。

知道 session ID 的任何人都可以:

- 订阅 `/sessions/:id/events` SSE 流，实时看到 agent 的思考和工具调用
- 通过 `/sessions/:id/messages` 发送消息
- 通过 `/sessions/:id/control` 发送控制指令
- 查看和删除 session

**修复建议:**

- 添加 API token 或 JWT 认证中间件
- 至少验证请求的来源
- 使用随机 session token 而非递增 ID 作为密钥

---

### H2. Session ID 可预测 — 缺乏熵

**文件:** `apps/server/src/sessions/sessions.service.ts:573-576`

```typescript
private nextSessionId(): string {
  this.sessionOrdinal += 1;
  return `session-${String(Date.now())}-${String(this.sessionOrdinal)}`;
}
```

**问题:**

- Session ID 格式: `session-{timestamp}-{ordinal}`
- 时间戳暴露了 session 创建时间
- ordinal 从 1 递增，可以遍历
- 攻击者可以预测其他用户的 session ID

**修复建议:**

```typescript
import { randomUUID } from 'node:crypto';
private nextSessionId(): string {
  return `session-${randomUUID()}`;
}
```

---

### H3. 没有速率限制

**问题:** 整个 API 缺少速率限制，攻击者可以:

- 暴力猜测 session ID
- 创建大量 session 耗尽 SQLite 存储
- 通过不断发送消息进行 DoS
- 快速轮询 SSE 端点

**修复建议:** 使用 `@nestjs/throttler` 或 Fastify 的 rate-limit 插件。

---

### H4. `PluginStore` 和 `SessionStore` 各自独立打开同一数据库

**文件:**

- `apps/server/src/persistence/session-store.ts:76`
- `apps/server/src/plugins/plugin-store.ts:53`

```typescript
// SessionStore
this.handle = openDatabase(env.databasePath);

// PluginStore
this.handle = openDatabase(env.databasePath);
```

**问题:**

- 两个独立的 store 各自打开同一个 SQLite 数据库文件
- 虽然 WAL 模式支持多连接，但这导致:
  - 双倍的文件描述符消耗
  - 潜在的 `SQLITE_BUSY` 错误
  - 事务边界分散，跨 store 操作无法放进同一个事务
  - WAL checkpoint、关闭顺序和连接生命周期更难统一管理

**修复建议:**

- 创建共享的 `DatabaseProvider` 通过 NestJS DI 注入
- 或让 `PluginStore` 接受外部 `PersistenceDatabase` 实例

```typescript
// 在 config.module.ts 中
@Module({
  providers: [{
    provide: PERSISTENCE_DB,
    useFactory: (env: ServerEnvironment) => openDatabase(env.databasePath),
    inject: [SERVER_ENV],
  }],
  exports: [PERSISTENCE_DB],
})
```

---

### H5. 大量 try-catch 静默吞噬错误

**文件:** `apps/server/src/sessions/sessions.service.ts` (多处)

```typescript
private persist(session: Session, pendingAudit: PermissionAuditEntry[]): void {
  try {
    // ...
  } catch {
    // Swallow: persistence is a side channel; never let it break a run.
  }
}
```

**问题:**

- `persist()` — 持久化失败 → 对话历史静默丢失
- `preloadRecentSessions()` — 恢复失败 → 历史会话不可见
- `safeUpsertSessionMetadata()` — 元数据写入失败 → session 可能无法按项目分组
- `saveRunCheckpoint()` — checkpoint 保存失败 → 无法回滚

虽然注释说"不应中断运行"，但错误需要至少被记录。

**修复建议:** 所有 try-catch 至少添加 `console.error()` 日志:

```typescript
} catch (error) {
  console.error('Session persistence failed for', session.id, error);
}
```

---

### H6. SSE replay buffer 无上限 — 长会话会拖慢重连并持续吃内存

**文件:** `apps/server/src/sessions/sessions.service.ts:600-624`

**问题描述:**

```typescript
const log: SessionEvent[] = [];
// ...
entry.unsubscribe = session.subscribe((event) => {
  log.push(event);
  for (const listener of listeners) {
    listener(event);
  }
});
```

**问题:** 每个 live session 都维护一个进程内 `SessionEvent[]`，所有事件都会追加进去。`events()` 新订阅时会同步 replay 整个 `log`。长对话、多工具调用、开启 file watcher 或 LSP 后，事件数量会持续增长。

**影响:**

- 浏览器刷新或 SSE 重连时，会一次性回放大量旧事件，页面恢复变慢
- live session 长时间不 dispose 时，内存持续增长
- file watcher 在大项目中可能产生大量 `file_changed` 事件，进一步放大 replay 成本

**修复建议:**

- 使用 ring buffer，只保留最近 N 条事件或最近 N 个 run 的事件
- 将可恢复状态（history、todos、edit proposals、usage）和瞬时事件分离，重连时只发送状态快照 + 增量事件
- 对 `file_*`、`message_delta` 这类高频事件做合并或不进入 replay buffer

---

### H7. Checkpoint 每轮保存完整 snapshot，且列表接口全量反序列化

**文件:**

- `apps/server/src/sessions/sessions.service.ts:1056-1065`
- `apps/server/src/persistence/session-store.ts:295-302`

**问题描述:**

```typescript
const checkpoint = this.buildCheckpoint(entry.session.snapshot(), {
  parentCheckpointId: entry.currentCheckpointId,
  runId: event.runId,
});
this.store.saveCheckpoint(checkpoint);

listCheckpoints(sessionId: string): Checkpoint[] {
  return rows.map((row) => this.toCheckpoint(row)); // JSON.parse(row.snapshot)
}
```

**问题:** 每个 run 结束都会保存一个 checkpoint，而 checkpoint 内包含完整 `SessionSnapshot`。`listCheckpoints()` 又会读取该 session 的全部 checkpoint，并把每个 checkpoint 的完整 snapshot 都 `JSON.parse` 出来。

**影响:**

- 长会话的数据库体积会快速膨胀
- checkpoint 面板打开会越来越慢
- 清理、恢复、fork 操作都要处理大量重复历史

**修复建议:**

- 增加保留策略，例如每个 session 只保留最近 20 个 checkpoint，或按时间/手动标记保留
- 列表接口只返回 `id`、`createdAt`、`label`、`summary` 等元数据，恢复时再加载完整 snapshot
- 长期可以考虑增量 checkpoint 或只保存关键节点

---

### H8. Session 历史列表全量读取并解析 snapshot，历史多时首页会变慢

**文件:**

- `apps/server/src/sessions/sessions.service.ts:1329-1365`
- `apps/server/src/persistence/session-store.ts:104-112`

**问题描述:**

```typescript
for (const entry of this.store.listSessions()) {
  const summary = this.toSessionSummary(entry);
  // ...
}

listSessions() {
  return rows.map((row) => ({
    snapshot: JSON.parse(row.snapshot) as SessionSnapshot,
    updatedAt: row.updatedAt,
  }));
}
```

**问题:** 历史列表接口会加载所有 session，并反序列化每个完整 `SessionSnapshot`。`toSessionSummary()` 还会为每个 session 查询 checkpoint 和 metadata。

**影响:**

- 聊天历史越多，打开页面、刷新侧边栏越慢
- 大历史 snapshot 会把列表接口变成高 CPU / 高内存操作
- `clearSessions()`、`deleteProject()` 也依赖 `listSessions()`，批量清理前会先做一次昂贵的全量读取

**修复建议:**

- 在 `sessions` 或 `session_metadata` 表中保存 `title`、`cwd`、`projectId`、`pinned`、`updatedAt`、`latestCheckpointId` 等摘要字段
- 列表接口分页，避免一次性返回所有历史
- `clearSessions()` 和 `deleteProject()` 使用数据库条件查询目标 ID，不通过完整 history 汇总结果反推

---

## 🟡 中等优先级 (Medium)

### M1. `retry.ts` 对流式中断不重试

**文件:** `apps/server/src/model/retry.ts:22-44`

```typescript
let producedOutput = false;
for await (const event of stream) {
  producedOutput = true;
  yield event;
}
// 如果已经生产了输出，流中断后不会重试
```

**问题:** 一旦 `producedOutput = true`，流中任何错误都会直接抛出。如果模型在生成 90% 的响应后网络断开，用户会看到被截断的响应。在实践中，流式 LLM API 的中途断连是很常见的。

**修复建议:** 至少 emit 一个 error 事件通知前端，让用户可以手动重试。不过要注意，流式重试本质上是不可行的（无法 "resume" 一个流），所以这不是 bug，而是需要前端友好的错误处理。

---

### M2. 手动 compaction 的 fire-and-forget 问题

**文件:** `packages/tool-runtime/src/session/session.ts:615-652`

```typescript
void (async () => {
  const result = await compactHistory({...});
  if (result) {
    this.emit({ type: 'context_compacted', ... });
  }
})().catch((error: unknown) => {
  this.emit({ type: 'context_compaction_failed', ... });
});
```

**问题:**

- Compaction 过程中如果 session 被 dispose，结果可能 emit 到已不存在的 session
- `abortController` 被创建但没有保存在任何地方，dispose 时无法中止压缩

**修复建议:** 添加 `isDisposed` 标志，emit 前检查。

---

### M3. `turn.ts` 中每轮都重新 describe tools

**文件:** `packages/tool-runtime/src/session/turn.ts:115`

```typescript
for (let round = 0; ; round += 1) {
  const tools = describeTools(deps.registry.list()); // 每轮重建
```

**问题:** 在一个最多 64 轮的循环中，工具描述在每轮都被重建。虽然 `describeTools` 可能很快，但大规模工具列表下会产生不必要的开销。

**修复建议:** 在 turn 开始时缓存工具描述，只在 compaction 后重新计算（因为 compaction 后 context 变了，但工具列表没变）。

---

### M4. File watcher 默认轮询间隔仅为 50ms

**文件:** `packages/tool-runtime/src/session/file-watcher.ts:175`

```typescript
const timer = setInterval(() => {
  // ...
}, options.pollIntervalMs ?? 50); // 默认 50ms
```

**问题:** 50ms 的轮询间隔意味着每秒 20 次完整的文件树扫描。对于大型项目（数千文件），这会导致持续的高 CPU 使用率和磁盘 I/O。

**修复建议:** 将默认轮询间隔改为 500ms 或 1000ms。对大多数用例来说，1 秒的延迟是可以接受的。

---

### M5. `projectMcpServers` 向根目录遍历可能加载意外配置

**文件:** `apps/server/src/config/mcp-config.ts:177-199`

```typescript
for (let dir = resolve(cwd); ; dir = dirname(dir)) {
  for (const relative of PROJECT_MCP_CONFIG_FILES) {
    // 从 cwd 一路查找到文件系统根目录
  }
  const parent = dirname(dir);
  if (parent === dir) break;
}
```

**问题:** 这会在从 cwd 到 `/` 的每个目录中查找 MCP 配置文件。如果你的项目在 `/home/user/projects/my-app`，它会加载 `/home/user/projects/my-app/.mcp.json`、`/home/user/projects/.mcp.json`、`/home/user/.mcp.json`、`/home/.mcp.json`、`/.mcp.json`。用户可能不知道这些文件会影响他们的 session。

**修复建议:** 添加一个边界停止点（如 git 仓库根目录或 home 目录），而不是一直走到 `/`。

---

### M6. `safeMarkdownHref` 不是实际漏洞，但建议补充测试和注释

**文件:** `apps/web/app/agent/page.tsx:949-954`

```typescript
function safeMarkdownHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return '#'; // 不安全的链接改为 #
}
```

**问题:**

- `javascript:` 和 `data:` URL 都不会命中白名单，实际会被改为 `#`
- 因此这里不应算作中等优先级安全漏洞
- 但这段逻辑缺少测试，未来如果放宽协议白名单，容易引入 XSS 回归

**修复建议:** 为 `javascript:`、`data:`、协议相对 URL、相对路径、hash link 增加单元测试，并用注释明确这是白名单策略:

```typescript
if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
```

---

### M7. `WebBrowserTool` 和 `WebFetchTool` 默认使用相同的 provider 且无超时

**文件:** `packages/tool-runtime/src/core/tool.ts:382-401`

```typescript
async function defaultWebFetch(url: string): Promise<string> {
  const response = await fetch(url, {  // 没有超时限制!
    headers: { ... },
  });
```

**问题:** `fetch` 没有超时限制。一个恶意 URL 可以永远挂起连接。此外，`WebBrowser` 和 `WebFetch` 共享同一个 `webFetchProvider`，这意味着它们的行为完全一样，但被暴露为两个不同的工具。

**修复建议:** 添加 `AbortSignal.timeout()` 或 `Promise.race` 超时。

---

### M8. MCP 工具名称清理过于激进

**文件:** `apps/server/src/plugins/plugin-store.ts:31-36`

```typescript
function serverName(registryName: string): string {
  return registryName
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
```

**问题:** 两个不同的 registry 名称可能映射到相同的 server name（碰撞）。例如 `my-server` 和 `my--server` 都会变成 `my-server`。如果两个不同的 MCP 服务器碰撞，后面安装的会静默覆盖前面的。

**修复建议:** 至少记录冲突警告，或使用更精确的规范化。

---

### M9. 启动时预加载最近 3 天所有 session，可能拖慢冷启动

**文件:** `apps/server/src/sessions/sessions.service.ts:331-356`

**问题描述:**

```typescript
onModuleInit(): void {
  queueMicrotask(() => {
    void this.preloadRecentSessions();
  });
}

for (const entry of persisted) {
  if (entry.updatedAt < cutoff || this.entries.has(entry.snapshot.id)) {
    continue;
  }
  await this.restore(entry.snapshot.id);
}
```

**问题:** 服务启动后会读取所有 session，再恢复最近 3 天的 session。`restore()` 可能重新初始化 MCP / LSP manager，恢复过程并不只是读取 JSON。

**影响:**

- 最近会话很多时，服务冷启动后会出现一段资源高峰
- 如果某些 MCP / LSP 初始化慢，预加载会放大启动后的卡顿
- 预加载异常被吞掉，用户只会感觉历史或工具状态偶发不可用，排查困难

**修复建议:**

- 改成懒加载：用户打开某个历史 session 时再 restore
- 或只预加载 pinned / 最近 N 个 session
- 预加载失败至少记录 session ID 和错误原因

---

### M10. MCP Registry 远程请求没有超时

**文件:** `apps/server/src/plugins/plugin-registry.ts:120-150`

**问题描述:**

```typescript
const response = await fetch(
  this.baseUrl + '/v0.1/servers' + queryString(options),
);

const response = await fetch(
  this.baseUrl + '/v0.1/servers/' + encodeURIComponent(name) + ...
);
```

**问题:** 插件市场接口直接调用远程 `fetch()`，没有 `AbortController` 或超时。网络异常、DNS 问题、远端连接不释放时，请求会长时间悬挂。

**影响:**

- `/plugins/registry/mcp` 和 `/plugins/registry/mcp/:name` 可能长时间无响应
- 前端插件市场页面表现为一直加载
- 多个悬挂请求会占用服务端资源

**修复建议:** 参考 `models-service.ts` 中的 15 秒超时模式，为 registry client 增加统一超时:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
try {
  return await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

---

## 🟢 低优先级 / 改进建议 (Low)

### L1. 前端组件过大 (4466 行)

**文件:** `apps/web/app/agent/page.tsx` — **4466 行**

**问题:** 整个 agent 页面在一个文件中，包含 UI、逻辑、状态管理、国际化、markdown 渲染等所有内容。这导致:

- 难以维护和测试
- 任何修改都需要仔细审查大文件
- 无法单独测试各功能模块
- React 重渲染可能不必要地影响所有子组件

**修复建议:** 拆分:

- `i18n.ts` — 国际化文本 (~350 行)
- `settings-dialog.tsx` — 设置对话框 (~700 行)
- `sidebar-nav.tsx` — 侧边栏导航 (~300 行)
- `composer.tsx` — 消息输入区 (~400 行)
- `markdown-renderer.tsx` — Markdown 渲染 (~200 行)
- `conversation-view.tsx` — 对话显示 (~500 行)
- `page.tsx` — 主页面 (约 1000 行)

---

### L2. `sessionId` 作为 React state 和 ref 的双重维护

**文件:** `apps/web/app/agent/page.tsx:1087, 1255-1259`

```typescript
const [sessionId, setSessionId] = useState<string | null>(null);
const sessionIdRef = useRef<string | null>(null);

useEffect(() => {
  sessionIdRef.current = sessionId;
}, [sessionId]);
```

**问题:** 需要在 state 更新后手动同步 ref，容易遗漏。在快节奏事件处理中（SSE 事件），可能读到过时的 ref 值。

**修复建议:** 使用 `useCallback` 模式或直接让事件处理器从闭包中读取最新值。

---

### L3. `contextTokens` 对所有 preset 硬编码为 1M

**文件:** `apps/web/app/agent/page.tsx:702-706`

```typescript
const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  claude: 1_000_000,
  deepseek: 1_000_000,
  openai: 1_000_000, // GPT 模型实际可能是 128K 或 256K
};
```

**问题:** GPT-5 可能不支持 1M context window，显示错误的百分比会误导用户。不同模型的实际 context window 差异很大。

**修复建议:** 从服务端 `/models/presets` 返回 model 的实际 context window 大小。

---

### L4. `compact` control message 创建的 AbortController 未对外暴露

**文件:** `packages/tool-runtime/src/session/session.ts:613`

```typescript
case 'compact': {
  const abortController = new AbortController();
  // abortController 传入 compactHistory 但没有保存引用
```

**问题:** dispose session 时无法中止正在进行的压缩操作。

**修复建议:** 将 abortController 保存为实例变量。

---

### L5. `truncateToolResultContent` 中的截断通知被计算了两次

**文件:** `packages/tool-runtime/src/core/tool.ts:280-316`

```typescript
export function truncateToolResultContent(content: string, maxChars = ...): string {
  // 第一次计算 truncation notice
  let notice = '\n\n[tool output truncated: showing head and tail]\n\n';
  let available = Math.max(0, maxChars - notice.length);
  let headChars = Math.ceil(available / 2);
  let tailChars = Math.floor(available / 2);
  let omittedChars = content.length - headChars - tailChars;

  // 第二次重新计算，覆盖了第一次的值（notice 中包含了具体数字）
  notice = '\n\n[tool output truncated: omitted ' + omittedChars + ...;
  available = Math.max(0, maxChars - notice.length);
  headChars = Math.ceil(available / 2);
  tailChars = Math.floor(available / 2);
  omittedChars = content.length - headChars - tailChars;
  notice = '\n\n[tool output truncated: omitted ' + omittedChars + ...;
```

**问题:** 第一次计算的变量值在第二次计算中被覆盖，第一次计算完全是浪费的。

**修复建议:** 删除第一次计算，只保留第二次（带具体数字的）。

---

### L6. MCP 内置工具被过滤后又被重新添加

**文件:** `apps/server/src/sessions/sessions.service.ts:508-516`

```typescript
// 先从 builtins 中移除 MCP 内置工具
const mcpBuiltinNames = new Set(['MCPTool', 'McpAuth', ...]);
tools = tools.filter((tool) => !mcpBuiltinNames.has(tool.name));

// 然后 createMcpRuntimeTools 通过 createMcpTools() 又添加了它们
tools = [...tools, ...mcpTools];
```

**问题:** 看似冗余的逻辑（删除再添加），但实际上是正确的设计 — 只有当 MCP servers 被配置时才添加 MCP 工具。然而，代码意图不够清晰。

**修复建议:** 添加注释解释为什么先删后加。

---

### L7. `serverName` 函数可能导致 MCP server name 碰撞

**文件:** (见 M8 中的 `plugin-store.ts:31-36`)

同一问题，不同影响级别 — 这里可能导致功能问题。

---

### L8. 硬编码的 `DEFAULT_MAX_TOKENS = 8192` 可能不够

**文件:** `apps/server/src/model/anthropic-client.ts:51`

```typescript
const DEFAULT_MAX_TOKENS = 8192;
```

**问题:** 对于大型代码生成任务，8192 tokens 的 output 限制可能不够。Claude 在某些模型中支持 32K output。这会导致模型在不应被截断时被截断。

**修复建议:** 允许在 model preset 中为不同模型配置不同的 maxTokens 默认值。

---

### L9. SSE 事件类型依赖 string 匹配

**文件:** `apps/web/app/agent/page.tsx:1928-1937`

```typescript
for (const type of SESSION_EVENT_TYPES) {
  source.addEventListener(type, (raw: MessageEvent<string>) => {
    // ...
  });
}
```

**问题:** 如果后端添加了新的事件类型但没有更新 `SESSION_EVENT_TYPES`，新事件会被静默忽略。

**修复建议:** 添加一个 "catch-all" 的 `message` 事件监听器，对未知事件类型进行 warn 日志。

---

### L10. `disable-context-menu.tsx` 禁用右键菜单

**文件:** `apps/web/app/disable-context-menu.tsx`

**问题:** 完全禁用右键菜单是非常规做法，会破坏无障碍访问和用户期望。如果目的是保护内容，可以通过更温和的方式（如只在特定区域禁用）。

---

### L11. `next-env.d.ts` 是自动生成文件，不建议手动修改

**文件:** `apps/web/next-env.d.ts`

**问题:** `next-env.d.ts` 文件头部已经写明 `This file should not be edited`。如果手动把 route type 路径改为某个特定构建模式下的 `.next/dev/types/routes.d.ts`，在不同 Next 命令、CI 或生产构建下可能被自动覆盖，或导致类型路径不稳定。

**修复建议:** 不要手动提交该文件的构建产物路径变化。需要 route types 时，让 `next typegen`、`next dev` 或 `next build` 生成当前 Next 版本期望的内容。

---

## 📋 逐文件问题清单

### apps/server/

| 文件                                  | 问题                                                                                                                                                                                  | 严重度 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/main.ts`                         | 无明显问题                                                                                                                                                                            | -      |
| `src/sessions/sessions.service.ts`    | Session ID 可预测 (H2), configureModel 逻辑缺陷 (C4), 错误静默吞噬 (H5), SSE replay buffer 无上限 (H6), checkpoint 保存完整 snapshot (H7), 历史列表全量解析 (H8), 启动预加载过重 (M9) | 🔴🟠🟡 |
| `src/sessions/sessions.controller.ts` | 无认证 (H1), 无速率限制 (H3), 所有端点无保护                                                                                                                                          | 🟠     |
| `src/sessions/model-factory.ts`       | 无明显问题 (清晰的工厂模式)                                                                                                                                                           | -      |
| `src/sessions/voice-transcription.ts` | 未审查完整文件                                                                                                                                                                        | -      |
| `src/model/anthropic-client.ts`       | 硬编码 maxTokens (L8)                                                                                                                                                                 | 🟢     |
| `src/model/openai-client.ts`          | 无明显问题 (正确的流式实现)                                                                                                                                                           | -      |
| `src/model/retry.ts`                  | 流式中断不重试 (M1)                                                                                                                                                                   | 🟡     |
| `src/model/create-model-client.ts`    | 无明显问题                                                                                                                                                                            | -      |
| `src/model/model-config.ts`           | 无明显问题                                                                                                                                                                            | -      |
| `src/persistence/database.ts`         | 无明显问题 (正确使用 WAL 模式)                                                                                                                                                        | -      |
| `src/persistence/session-store.ts`    | 与 PluginStore 重复打开 DB (H4), checkpoint 列表全量反序列化 (H7), session 列表全量反序列化 (H8)                                                                                      | 🟠     |
| `src/config/environment.ts`           | 无明显问题 (良好的验证逻辑)                                                                                                                                                           | -      |
| `src/config/mcp-config.ts`            | 无限向上遍历目录 (M5)                                                                                                                                                                 | 🟡     |
| `src/config/lsp-config.ts`            | 同步 which 调用阻塞事件循环                                                                                                                                                           | 🟢     |
| `src/plugins/plugin-store.ts`         | 与 SessionStore 重复打开 DB (H4), serverName 碰撞 (M8)                                                                                                                                | 🟠🟡   |
| `src/plugins/plugin-registry.ts`      | MCP Registry 远程请求没有超时 (M10)                                                                                                                                                   | 🟡     |

### packages/tool-runtime/

| 文件                          | 问题                                                                                      | 严重度 |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| `src/tools/bash.ts`           | `sh -lc` 安全隐患 (C2)                                                                    | 🔴     |
| `src/tools/files.ts`          | TOCTOU 竞态条件 (C3)                                                                      | 🔴     |
| `src/tools/network.ts`        | fetch 无超时 (M7)                                                                         | 🟡     |
| `src/session/session.ts`      | Concurrent submit 竞态 (C5), compaction fire-and-forget (M2), AbortController 不暴露 (L4) | 🔴🟡🟢 |
| `src/session/turn.ts`         | 每轮重建工具描述 (M3)                                                                     | 🟡     |
| `src/session/file-watcher.ts` | 50ms 默认轮询间隔过高 (M4)                                                                | 🟡     |
| `src/core/tool.ts`            | truncateToolResultContent 计算浪费 (L5)                                                   | 🟢     |
| `src/core/permissions.ts`     | 无明显问题 (清晰的权限分层)                                                               | -      |
| `src/core/runner.ts`          | 无明显问题 (分层决策逻辑正确)                                                             | -      |
| `src/core/hooks.ts`           | 无明显问题 (支持 fail-open/fail-closed)                                                   | -      |
| `src/mcp/client.ts`           | 无明显问题 (正确的 SDK 使用)                                                              | -      |
| `src/lsp/client.ts`           | LSP JSON-RPC 请求没有超时 (C6)                                                            | 🔴     |

### apps/web/

| 文件                          | 问题                                                                                                                               | 严重度 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `app/agent/page.tsx`          | API key 存 localStorage (C1), 4466 行过大 (L1), sessionId 双重维护 (L2), contextTokens 硬编码 (L3), safeMarkdownHref 缺少测试 (M6) | 🔴🟡🟢 |
| `app/agent/api.ts`            | 无明显问题                                                                                                                         | -      |
| `app/agent/state.ts`          | 无明显问题 (正确的纯函数式 state 管理)                                                                                             | -      |
| `app/agent/voice-recorder.ts` | resampleFloat32 使用最近邻插值而非线性插值                                                                                         | 🟢     |
| `app/agent/markdown.ts`       | 简单的 regex 解析器，未处理嵌套标记                                                                                                | 🟢     |
| `app/agent/desktop.ts`        | 无明显问题                                                                                                                         | -      |
| `next-env.d.ts`               | 自动生成文件，不建议手动修改 (L11)                                                                                                 | 🟢     |

### apps/desktop/

| 文件                   | 问题                                                                          | 严重度 |
| ---------------------- | ----------------------------------------------------------------------------- | ------ |
| `src-tauri/src/lib.rs` | server_allows_tauri_origin 手动发送 HTTP (portable?), 测试中 kill -0 不可移植 | 🟢     |
| 整体                   | 良好的结构和测试覆盖率                                                        | -      |

### apps/cli/

| 文件          | 问题                    | 严重度 |
| ------------- | ----------------------- | ------ |
| `src/main.ts` | 无明显问题 (清晰的实现) | -      |

---

## 📊 总结与修复优先级建议

### 修复顺序

#### 第一轮 (本周) — 安全性

1. **C1**: API key localStorage → 至少加密存储
2. **H1**: 添加 API 认证 (token/JWT)
3. **H2**: Session ID → `crypto.randomUUID()`
4. **C2**: Bash `sh -lc` → `sh -c`
5. **H3**: 添加速率限制
6. **C6**: LSP JSON-RPC 请求增加超时和 pending 清理

#### 第二轮 (下周) — 正确性

7. **C5**: Concurrent submit 加锁
8. **C4**: configureModel 逻辑修复
9. **H5**: try-catch 添加错误日志
10. **H6**: SSE replay buffer 增加上限或改为快照 + 增量模式

#### 第三轮 (后续) — 优化

11. **H4**: 共享数据库连接
12. **H7/H8**: checkpoint 与 session 列表改为摘要字段 + 分页
13. **M4**: File watcher 间隔调整
14. **M5**: MCP config 遍历范围限制
15. **M9**: session 预加载改为懒加载或限制数量
16. **M10**: MCP Registry 请求增加超时
17. **L1**: 前端组件拆分

### 项目优势

经过全面审查，项目在以下方面做得很好:

- ✅ **架构设计**: Session → Turn → Runner → Scheduler 的分层非常清晰
- ✅ **权限系统**: `evaluatePermission` 的分层决策 (bypass → plan/readOnly → rules → acceptEdits → MCP trust → default) 设计良好
- ✅ **Schema 验证**: 自定义的轻量级 schema 系统，没有引入重型验证库
- ✅ **错误处理策略**: "持久化不应中断运行" 的理念正确，只需添加日志
- ✅ **模型适配器**: Anthropic 和 OpenAI 适配器都正确实现了流式处理
- ✅ **TypeScript 使用**: 类型安全做得很好，`unknown` 到具体类型的验证模式一致
- ✅ **测试**: desktop Tauri 有良好的测试覆盖
- ✅ **SQLite WAL**: 正确使用 WAL 模式提高并发性能
- ✅ **API 验证**: Controller 层的输入验证是手工但完善的

### 总体评估

代码质量整体**中上**。核心引擎设计良好，但生产环境的安全加固 (authentication, rate limiting, key management, sandboxing) 不足。这些是 MVP → 生产环境部署的关键差距。

---

## 🧭 2026-07-10 并发、一致性与协议补充审查

> 审查范围：`packages/tool-runtime`、`apps/server`、`apps/web`、`apps/cli`、`apps/desktop`，以及对应测试。
>
> 审查重点：异步状态机、取消语义、审批协议、事件重放、文件一致性、SQLite 写锁、进程生命周期和跨客户端状态一致性。
>
> 证据标记：**已复现**表示使用当前源码构造了确定性时序；**静态确认**表示调用链与状态变化可以直接从代码证明，但尚未增加正式回归测试。

### 补充结论

原报告对安全和性能技术债的方向判断基本正确，但低估了 Session 状态机与跨层协议问题。此次审查确认：当前最主要的风险不是传统线程数据竞争，而是 Promise 交错、fire-and-forget 任务、缺少 generation fencing，以及客户端把“至少一次投递”误当成“恰好一次投递”。

在继续开发 2.0 客户端之前，建议先建立稳定性门禁。Contract 设计可以同步推进，但 SwiftUI、Ink 完整体验和新插件能力不应继续建立在当前 Session/Event 语义上。

### 风险总表

| ID  | 级别 | 证据              | 问题                                                               | 是否阻塞 2.0 客户端  |
| --- | ---- | ----------------- | ------------------------------------------------------------------ | -------------------- |
| R1  | P0   | 已复现            | 自定义 `baseURL` 可携带服务端 API Key 外送                         | 是，且需立即热修     |
| R2  | P0   | 已复现 + 静态确认 | MCP trust、Permission Mode、恢复逻辑存在安全语义冲突               | 是                   |
| R3  | P0   | 已复现            | `cancel` 不是单调终态，取消后仍可新增审批或启动工具                | 是                   |
| R4  | P0   | 已复现            | 并行工具可产生多个审批，Web 只保留一个，run 永久等待               | 是                   |
| R5  | P0   | 已复现            | `submit`、compaction、edit decision 未形成原子状态机               | 是                   |
| R6  | P0   | 已复现            | `close`、restore、delete、checkpoint 切换缺少生命周期栅栏          | 是                   |
| R7  | P0   | 已复现            | 已配置 Session 的 `configureModel()` 返回成功但实际不生效          | 是                   |
| R8  | P0   | 已复现            | SSE 全量 replay 与非幂等 reducer 组合后重复消息和工具状态          | 是                   |
| R9  | P1   | 已复现            | compaction 后 restore 会复用旧 `runId`，缺少 epoch/sequence        | 是                   |
| R10 | P1   | 已复现            | Scheduler 无并发上限、fail-fast 留下无主 sibling，MCP/LSP 连接泄漏 | 是                   |
| R11 | P1   | 静态确认          | 文件编辑存在跨 Session lost update 与多文件部分提交                | 是                   |
| R12 | P1   | 已复现            | SQLite 无 `busy_timeout`，删除/回滚/审计不具备事务原子性           | 是                   |
| R13 | P1   | 已复现            | LSP、watcher、hook 和后台进程在关闭后仍可能产生 late effect        | 核心部分是           |
| R14 | P1   | 静态确认          | Web 异步请求、权限 UI、审批 UI 和语音分片缺少 request generation   | Web 过渡期需修最小集 |
| R15 | P1   | 静态确认          | CLI 失败路径、Tauri sidecar、macOS Speech 缺少完整生命周期管理     | CLI 是，Tauri 可后置 |
| R16 | P2   | 已复现            | Provider 截断被标为 completed，安全可重试的 pre-content 失败不重试 | 否，但应在发布前修   |

### R1. Named preset 的服务端密钥可被任意 endpoint override 带走

**[必须修复] [已复现]**

**文件：**

- `apps/server/src/sessions/model-factory.ts:58-107`
- `apps/server/src/model/model-config.ts:103-137`
- `apps/server/src/model/models-service.ts:96-104`
- `apps/server/src/model/create-model-client.ts:12-40`

请求可以选择 `preset: "openai"`，同时覆盖 `baseURL`，但不提供自己的 API Key。服务端会从环境变量解析 OpenAI Key，再把它作为 Bearer Token 发往请求方指定的地址。`/models/list`、`/models/test` 和后续 Session submit 都受影响；在当前 API 尚未鉴权的情况下，这条路径可以被直接远程利用。

定向验证观察到请求目标为 `https://attacker.invalid/v1/models`，请求头为 `Authorization: Bearer SERVER_SECRET`。

**建议：**

- named preset 使用服务端凭据时，禁止覆盖 `protocol` 和 `baseURL`，endpoint 必须绑定到受信任 preset。
- 使用自定义 endpoint 时必须提供请求级 API Key，且补充 URL scheme、内网地址和重定向策略。
- 在 H1 本地 API 认证完成前，不应把 `/models/test`、`/models/list` 暴露给任意来源。

### R2. Permission 决策顺序会绕过 blocked MCP，恢复后还会丢失规则

**[必须修复] [已复现 + 静态确认]**

**文件：**

- `packages/tool-runtime/src/core/permissions.ts:296-327,329-442`
- `packages/tool-runtime/src/mcp/adapter.ts:69-103`
- `packages/tool-runtime/src/session/session.ts:679-729`
- `apps/server/src/sessions/sessions.service.ts:376-399,790-855,954-1003`
- `apps/server/src/plugins/plugin-store.ts:165-205`

当前 `evaluatePermission()` 在 MCP trust 之前处理 `plan`、`readOnly`、`workspaceWrite` 和 `acceptEdits`。因此：

- blocked MCP 只要声明 `readOnlyHint: true`，在 `plan` / `readOnly` 下会直接 `allow`。
- blocked MCP 的输入只要带 workspace 内的 `path`，在 `acceptEdits` / `workspaceWrite` 下也可能直接 `allow`。
- `readOnlyHint` 同时被当成 `isConcurrencySafe`，但“只读提示”并不等价于“可并发执行”。

定向验证中，以上 4 种 blocked MCP 场景都返回了 `behavior: "allow"`。

恢复路径还有第二层问题：Server 构造了带 `mcpTrust` 的 `permissionContext`，但 `Session.restore()` 不接收它，并固定重建为 `rules: []`。这会丢失请求级 deny rule 和 MCP trust。插件从 trusted 改成 blocked、disable 或 delete 后，live Session 也不会更新工具、manager 或 trust，安全撤权无法即时生效。

**建议：** 把 blocked、sandbox boundary 等安全限制定义为不可被便捷模式覆盖的 ceiling；显式区分 `readOnly`、`sideEffectFree`、`concurrencySafe`；完整持久化并恢复 Permission Contract；对 live plugin revocation 定义立即生效或强制 session epoch 重建语义。

### R3. `cancel` 之后仍能新增 approval 或执行后续工具

**[必须修复] [已复现]**

**文件：**

- `packages/tool-runtime/src/session/session.ts:250-266,594-597`
- `packages/tool-runtime/src/core/runner.ts:194-268,292-336,415-424`
- `packages/tool-runtime/src/core/scheduler.ts:19-47`

`cancel` 只在某一时刻执行 `abort()` 和 `denyAllPending()`。如果工具正在等待异步 validation、hook 或 permission policy，此时 approval 尚未登记；这些步骤稍后返回 `ask` 后，仍会创建新的 pending Promise，run 永久停在 `running`。

定向复现：

```json
{ "settled": false, "approvals": 1, "statuses": ["running"] }
```

Scheduler 在串行工具之间也不检查 signal。工具 A 忽略取消并返回后，工具 B 仍会启动；内置文件工具并不统一检查 AbortSignal，因此取消后的写入不能排除。

**建议：** 取消状态必须是单调的。Runner 在每个异步边界后、`tool.call` 前检查 signal；Scheduler 在每次启动工具前检查；approval Promise 监听 signal，并在已 aborted 时立即 deny。`runId` / run epoch 必须随 control message 一起校验，避免迟到控制影响下一轮。

### R4. 并行审批与单槽 UI 会形成逻辑死锁

**[必须修复] [已复现]**

**文件：**

- `packages/tool-runtime/src/core/scheduler.ts:30-47`
- `packages/tool-runtime/src/session/session.ts:247-278`
- `packages/tool-runtime/src/mcp/adapter.ts:94-101`
- `apps/web/app/agent/state.ts:374-385`
- `apps/web/app/agent/page.tsx:2306-2323`

相邻 `concurrencySafe` 工具由 `Promise.all()` 并行运行。默认 trust 为 `ask` 的两个只读 MCP 工具会同时发出两个 `approval_required`，但 Web state 只有一个 `approval` 字段，后一条会覆盖前一条。用户处理可见的最后一条后，第一条仍留在 Session pending Map，整轮无法完成。

定向复现：

```json
{
  "approvalCount": 2,
  "settledAfterAnsweringVisibleLast": false
}
```

此外，Web 在发送审批响应之前先清空 approval；请求失败后，服务端继续等待，UI 却无法重试。

**建议：** Contract 明确 approval 是队列还是集合。短期可序列化“可能 ask”的工具；长期支持带状态的 approval queue，并为响应增加幂等 key、ack 和失败重试。不能仅在 UI 上增加第二个弹窗，而不定义批次取消与顺序语义。

### R5. Session 互斥域不完整：submit、compaction 和 edit decision 会相互破坏

**[必须修复] [已复现]**

#### Concurrent submit 的准确触发方式

`packages/tool-runtime/src/session/session.ts:458-545` 的问题成立，但原报告 C5 的触发解释需要修正。JS run-to-completion 使两个 idle submit 很难同时看到 `activeRun` 为空；稳定触发方式是 B、C 同时等待旧 run A。A 结束后，B、C 都已经越过唯一一次检查，于是并发启动。

定向验证得到 `maxConcurrentModelRuns = 2`，history 中先连续出现两个 user，再出现交错的 assistant。Web 在 run 中仍允许按 Enter 调用 `handleSend()`（`apps/web/app/agent/page.tsx:3375-3389`），因此正常操作即可暴露此窗口。

#### 双 compaction 会删除近期历史

`packages/tool-runtime/src/session/session.ts:601-651` 没有 single-flight；两个 manual compaction 基于同一旧 boundary 生成摘要，第一个 `splice()` 后，第二个仍用旧索引修改新数组。一次复现中，8 条 history 最终只剩 1 条 user；另一组复现中，6 条变成 2 条。

Web 的 `compacting` 只覆盖返回 202 的 HTTP 请求（`apps/web/app/agent/page.tsx:2293-2304`），并不覆盖真实 compaction 生命周期，因此不能充当互斥锁。

#### Edit decision 不是合法状态机

`packages/tool-runtime/src/session/session.ts:564-591` 对 approve/reject 没有 transition guard。approve 后立即 reject，实际事件顺序为：

```json
{
  "eventOrder": ["edit_approved", "edit_rejected", "edit_applied"],
  "finalStatus": "applied"
}
```

重复 approve 也会启动重复 apply。多文件 apply 在 `packages/tool-runtime/src/tools/files.ts:515-552` 中先检查所有文件、再逐个写入；外部修改可插入检查与写入之间，第二个文件失败时第一个文件不会回滚。

**建议：** 不要用一个持有整轮执行的全局 mutex，因为 approval/cancel 必须能中断当前 run。建议采用 Session actor：submit、compact、restore、configure、close 进入串行命令队列；approval/cancel 走带 run epoch 的中断通道；proposal 使用独立原子状态机 `proposed → approved → applying → applied/conflict`。

### R6. `close()`、restore、delete 和 checkpoint 切换缺少 lifecycle fencing

**[必须修复] [已复现]**

**文件：**

- `packages/tool-runtime/src/session/session.ts:548-552`
- `apps/server/src/sessions/sessions.service.ts:790-885,1293-1310,1430-1515`

`Session.close()` 只运行 `sessionEnd` hook 并关闭 watcher，不 abort/await active run，不等待 edit/compact，不停止 background process，也不拒绝 close 后的新命令。Server 的 dispose/unregister 把“已发出 cancel”当成“run 已结束”，随后关闭 MCP/LSP manager 并删除 entry。

并发 restore 的 `entries.has(id)` 是 check-then-await。两个请求都能构造 Session/manager，`register()` 最后直接 `entries.set()`，被覆盖的一套资源不会关闭。restore 已读 snapshot 后与 delete 交错，还会在 delete 返回后重新注册旧 Session；下一轮 persist 会把已删除数据复活。

checkpoint restore 会清空旧 entry listeners，再注册同 ID 的新 entry。已有 Observable 捕获旧 entry，连接不会 complete，也不会迁移，因而保持打开但永久静默。

**建议：** Session 增加 `open → closing → closed` 状态并跟踪所有子任务；Server 为 session/project 使用 keyed lifecycle lock、tombstone 与 generation；替换 entry 时先准备、原子交换、再关闭旧资源，失败必须回滚。SSE 应通过 session epoch 明确通知客户端重建，而不是留下静默连接。

### R7. `configureModel()` 的实际问题不是浪费，而是切换完全无效

**[必须修复] [已复现]**

**文件：**

- `apps/server/src/sessions/sessions.service.ts:724-727,1217-1236`
- `packages/tool-runtime/src/session/session.ts:127,151-160`

真实模型创建的 Session 持有裸 `ModelClient`，只有“初始未配置”的 Session 才持有 `SwappableModelClient`。对已配置 Session 调用 configure 时，新 wrapper 仅写入 `SessionEntry`，没有接到 Session 内部 readonly model；接口仍返回成功。

定向验证中，factory 调用为 `initial, updated, updated`，后续 assistant 仍输出 `initial`。因此原报告 C4 应从“浪费一个 client”升级为模型切换 no-op。

**建议：** 所有 Session 从创建起统一持有一个 swappable wrapper；swap 只允许发生在 run 边界，并记录 model revision，避免同一 turn 的不同 round 使用不同 provider。

### R8. SSE 是至少一次投递，客户端却按恰好一次应用

**[必须修复] [已复现]**

**文件：**

- `apps/server/src/sessions/sessions.service.ts:600-639,1273-1288`
- `apps/server/src/sessions/sessions.controller.ts:582-592`
- `apps/web/app/agent/page.tsx:1866-1939`
- `apps/web/app/agent/state.ts:319-385,488-559`

EventSource 自动重连后，Server 会重放完整 log；事件没有持久 sequence / SSE `id`，Web reducer 也不去重。同一 `message_delta → message → tool_call` 序列应用两次，会产生两份 assistant 和两份 tool。历史 terminal 状态还会再次触发 checkpoint/history 刷新，形成请求风暴；已经处理过的 approval 也会再次显示。

原报告 H6 不只是内存/性能问题，应升级为协议正确性问题。

**建议：** 2.0 Event Envelope 至少包含 `sessionId`、`sessionEpoch`、`eventSeq`、`runId`、`eventId`、`schemaVersion`。重连使用 `Last-Event-ID` 或显式 cursor，只回放缺口；客户端按 eventId 幂等应用。恢复采用 snapshot + delta，瞬时 delta 不进入无限日志。

### R9. compaction 后 restore 会复用旧 `runId`

**[建议修改] [已复现]**

**文件：**

- `packages/tool-runtime/src/session/session.ts:472-474,716-718`
- `packages/tool-runtime/src/session/compaction.ts:223-233`

restore 通过“当前 history 中 user 条数”重建 `runCounter`。compaction 会把多个 user turn 折叠成 1 条，因此恢复后的下一轮可能复用旧 runId。验证中原会话已有 `run-1` 到 `run-4`，compaction 后仅剩 1 个 user entry，restore 后下一轮重新生成了 `run-2`。

这会破坏事件去重、checkpoint 关联和跨恢复诊断。建议 run/event ID 使用 UUID 或持久化单调 counter；checkpoint fork/restore 增加 epoch，不能从可变 history 推导身份。

### R10. 并行调度与连接初始化缺少上限、drain 和 single-flight

**[必须修复] [已复现]**

**文件：**

- `packages/tool-runtime/src/core/scheduler.ts:30-47`
- `packages/tool-runtime/src/core/runner.ts:194-268,415-428`
- `packages/tool-runtime/src/mcp/client.ts:116-225`
- `packages/tool-runtime/src/lsp/client.ts:276-445`

Scheduler 会把所有相邻 `concurrencySafe` 工具一次性放进 `Promise.all()`；200 个工具的实测最大并发就是 200。Runner 只捕获 `tool.call` 异常，validation、hook 或 permission policy 抛错会让 `Promise.all` fail-fast，而 sibling 继续产生副作用。此时 run 已发 error，late sibling 没有 `tool_result`，也不进入 history。

MCP `connectAll()` 和 LSP `initialize()` 的 cache 都在异步握手后才写入。并发调用会创建两套 client/child，Map 覆盖其中一套；close 后仍各残留 1 个 ChildProcess。

**建议：** 有界并发；整个 Runner pipeline 统一返回终态结果；批次失败时 cancel 并 drain sibling；按 server name 保存 in-flight connect Promise，并为 manager 增加 closing generation。

### R11. 跨 Session 文件写入没有 keyed lock 或 CAS

**[必须修复] [静态确认]**

**文件：**

- `packages/tool-runtime/src/tools/files.ts:614-715`
- `packages/tool-runtime/src/tools/files.ts:515-552`

单个 Scheduler 会串行处理写工具，但不同 Session 可以同时操作同一 workspace。`EditTool` 在 read/check 与 `writeFile()` 之间仍有窗口；另一个 Session 可以插入写入，后者被静默覆盖。`WriteTool` 直接 truncate/write，读取方还可能观察到空文件或部分内容。proposal 的多文件应用也没有事务或 partial result。

**建议：** 增加按 canonical path/workspace root 的 mutation coordinator；写前做 revision/CAS；通过同目录临时文件 + 原子 rename 提交单文件；多文件操作使用 journal/rollback，至少准确返回 applied/failed 文件集合。不要用全局文件锁串行所有 workspace。

### R12. SQLite 当前是“立即失败”，不是“自动等待”

**[必须修复] [已复现]**

**文件：**

- `apps/server/src/persistence/database.ts:29-41`
- `apps/server/src/persistence/session-store.ts:354-387`
- `apps/server/src/sessions/sessions.service.ts:1032-1053,1430-1439`

`SessionStore` 与 `PluginStore` 使用独立连接，`PRAGMA busy_timeout` 实测为 0。WAL 允许并发读，但仍只有一个 writer；另一个连接持有 `BEGIN IMMEDIATE` 时，写请求会立即抛 `database is locked`。

hard delete 分 4 条 autocommit DELETE，没有 transaction。失败后 `safeDeleteSession()` 吞错，而 `deleteSession()` 因 precheck 见过数据仍可能返回成功，HTTP 204 与真实数据库不一致。permission audit 又在写入前先 `splice()`；append 失败时待写记录永久丢失。

checkpoint restore/fork 也是先切 live state、再分步写 snapshot/metadata/checkpoint，中途失败会留下 live/DB 分叉或 ghost fork。`currentCheckpointId` 只在内存，重启后 checkpoint parent chain 会断裂。

**建议：** 共享 DatabaseProvider；设置有限 `busy_timeout` 并记录重试指标；所有多表变更使用 transaction；先持久化候选状态，再原子交换 live generation；audit 只有在 commit 成功后才从内存队列确认删除。

### R13. LSP、watcher、hook 和 background process 会产生关闭后的 late effect

**[建议修改] [已复现]**

- LSP request 无 timeout，`closeConnection()` 的 shutdown 也复用无 timeout request，关闭可永久挂住（`packages/tool-runtime/src/lsp/client.ts:162-199`）。
- 首次并发查询同一文件可能重复 `didOpen(version=1)`；文件 watcher 对删除不发 `didClose`。
- watcher 每 50 ms fire-and-forget 一次全树扫描，没有 in-flight guard；`close()` 不等待扫描与 LSP sync（`file-watcher.ts:161-223`）。
- Hook timeout 只放弃等待，不会停止 hook；工具返回后，超时 hook 仍能修改 RuntimeContext 或外部状态（`core/hooks.ts:113-133`）。
- Session start hook 在构造函数中 fire-and-forget，第一轮可早于 `sessionStart` 完成；background Bash 完成后也不会从 Map 清理或由 close 停止。

这些问题应统一纳入 structured concurrency：每个子任务属于明确 scope，scope close 时能够 cancel、drain，并禁止提交过期 generation 的结果。

### R14. Web 客户端存在多组“旧请求晚到覆盖新状态”竞态

**[必须修复] [静态确认]**

**文件：** `apps/web/app/agent/page.tsx:1591-1601,1975-2064,2207-2400,2481-2528`

- 快速恢复 A → B 时，A 的晚响应可以覆盖 B；checkpoint 刷新同理。
- 删除 A 后切到 B，A 的删除回调仍可能执行 `resetActiveSession()` 清空 B。
- permission mode 先改 UI 再 POST，失败或乱序后 UI 可能显示 `plan`，Server 仍是 `bypass`。
- user message 先清 draft、插气泡再 POST，失败后形成幽灵消息。
- EventSource 关闭后已经排队的旧回调没有校验 source/session generation，仍能写入新会话。

建议所有 Session 级异步动作携带 operation generation/AbortSignal，落状态前核对目标 session；权限与审批使用服务端 ack 后提交，或保留可回滚 pending 状态。

语音路径还存在分片并发 POST、stop 不 drain、audio/stop 不带 requestId、双击 start 泄漏 MediaStream 等问题（`voice-recorder.ts:74-100`、`page.tsx:2207-2283`）。Web/Tauri 虽是过渡端，但至少要保证分片有序和旧 generation 无法停止新录音。

### R15. CLI 与桌面进程生命周期仍有断口

**[建议修改] [静态确认]**

- CLI 先创建 SSE task，再 await sendMessage；send 失败时 finally 只关 readline，不 abort/await stream，进程可挂住（`apps/cli/src/main.ts:28-42`）。
- Sidecar child 退出或启动超时后仍留在 `Option<Child>`，后续 ensure 不会 respawn；readiness 只检查 TCP/CORS，不校验 health body、版本、token 或进程所有权（`apps/desktop/src-tauri/src/lib.rs:140-180,335-394`）。
- 桌面退出只 kill 直接 child，没有优雅 shutdown 和进程组清理，MCP/LSP 子进程可能成为 orphan。
- macOS Speech singleton 没有 task generation；旧 recognition callback 可以把旧文本发给新任务，并执行 stop 终止新任务（`macos_speech.m:34-38,103-155`）。

CLI 是 2.0 标准客户端，应在 Contract 稳定阶段修复。Tauri/macOS 过渡实现可降低优先级，但 sidecar ownership 与进程树清理需要沉淀到未来 Rust daemon。

### R16. Provider 终止语义和重试边界不完整

**[建议修改] [已复现]**

Anthropic 的 `stop_reason=max_tokens`、OpenAI 的 `finish_reason=length/content_filter`，以及没有终止帧的 clean EOF，当前都会无条件产生 `end`，run 随后标为 completed 并保存 checkpoint。真正问题不是原报告 M1 所说的“已输出后不自动重试”——该策略可以避免重复文本——而是截断没有独立终态。

Retry wrapper 又包在 raw provider frame 外。只要先收到 `message_start` 或 role-only chunk，即使没有任何可见输出，也会把 `producedOutput` 设为 true，安全可重试的 503 被错误抑制。`/models/list` 仍无 timeout。

建议 Contract 增加 `incomplete` / `truncated` 终态和 retryable metadata；只有已经向客户端提交可见事件后才禁止透明重试。

### 锁竞争专项结论

| 层级               | 当前结论                                                    | 建议                                                  |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------- |
| TypeScript Session | 没有线程内存竞争，但存在大量跨 `await` 的逻辑竞态           | Session actor + run epoch；中断通道不能被普通队列阻塞 |
| Tool / 文件系统    | 没有跨 Session 的路径锁，存在 lost update                   | canonical path keyed lock + revision/CAS + 原子写     |
| SQLite             | 2 个连接、单 writer、`busy_timeout=0`；会立即 `SQLITE_BUSY` | 共享连接、有限等待、transaction、失败可观测           |
| Rust `Mutex`       | 未发现明确的锁顺序死锁；锁区总体较短                        | 保持无嵌套锁，避免在持锁时等待进程/授权/网络          |
| 外部进程           | MCP/LSP/sidecar 缺少 single-flight 和 generation            | structured concurrency，close 必须 cancel + drain     |

因此，不建议给整个应用加一把全局锁。那会把并行读退化为串行，还可能让 approval/cancel 等中断路径等待当前 run，制造真正的死锁。应按 Session、proposal、workspace path、MCP/LSP server name 分别建立最小互斥域。

### 对原报告的关键勘误

1. **C4 应升级：** 不只是重复创建 client，已配置 Session 的模型切换完全不生效。
2. **C5 结论正确、时序需修正：** 稳定场景是多个 submit 同时等待同一个旧 active run，而不是两个 idle 调用同时看到 null。
3. **H4 需补充：** WAL 不解决 writer contention；当前 `busy_timeout=0`，且 delete/checkpoint/audit 没有 transaction。
4. **H6 应升级：** 无界 replay 除了性能问题，还会在客户端产生重复消息、重复工具与请求风暴。
5. **M1 应重写：** partial stream 不透明重试是合理选择；真正缺口是 provider 截断/clean EOF 被当成 completed。
6. **M2 应升级：** manual compaction 已能稳定造成 history 数据丢失，不是普通 fire-and-forget 清理问题。
7. **M4 应补充：** 50 ms 不只是轮询频繁，还允许全树扫描重叠，close 不 drain。
8. **L2 根因不准确：** 当前所有 `setSessionId` 关键路径都同步更新 ref；真正问题是异步操作没有 generation fencing。
9. **L9 修复建议不可行：** EventSource 的普通 `message` listener 捕获不到未知的具名 event。应统一 envelope 或在 schema/version 层检测。
10. **`runner.ts`、`state.ts`、CLI、Desktop 不能再标记为“无明显问题”：** 分别存在取消/批次、replay 幂等、Abort 生命周期和 sidecar/speech generation 缺口。
11. **C1 的“前端自行加密”不应作为首选热修：** 没有独立用户密钥时只是可逆混淆。过渡 Web 应停止长期持久化；原生端使用 OS Keychain，Server 只接收短生命周期引用或请求级 secret。

### 建议的实施顺序

#### Gate 0：立即热修，不等待 2.0 重构

1. 封死 R1 服务端密钥外送；同时完成 H1/H2 的本地 API token 和随机 Session ID。
2. 修正 R2 trust ceiling 与 Bash `find -delete` / `find -exec` / `git --output` 误判；仅移除 `sh -l` 不足以修复权限问题。
3. 让 cancel 在所有阶段可终止，临时禁止并发 manual compaction，修复 `configureModel()` no-op。
4. Web 在 running 时禁止 Enter submit；approval 响应失败可重试；Permission Mode 不再显示未 ack 的安全状态。

#### Gate 1：重构 Headless Core 的状态机

1. Session actor：命令串行，中断带 epoch，close 为真正终态。
2. 有界 Tool Scheduler：每个 tool 都有 completed/error/cancelled 终态，批次必须 drain。
3. Proposal 状态机与 workspace mutation coordinator。
4. MCP/LSP/Hook/Watcher 进入 structured concurrency，统一 timeout、cancel、close。

#### Gate 2：冻结 2.0 Contract 与持久化事务

1. 定义 Session / Run / Control / Event / Approval / Error 的稳定 wire schema。
2. Event Envelope 引入 epoch + sequence + resume cursor；实现 snapshot + delta。
3. 共享 DatabaseProvider，补 transaction、busy timeout、current checkpoint pointer 和 schema migration。
4. 权限规则、plugin trust、model revision 的恢复与热更新语义进入 Contract。

#### Gate 3：以 CLI 做故障验收，再推进原生客户端

CLI 先覆盖 create/restore/message/approval/cancel/reconnect/checkpoint/model switch，并通过断网、迟到响应、重复事件和 Server 重启测试。满足门禁后再推进 SwiftUI；否则每个客户端都会各自补一套不兼容的竞态 workaround。

### 必须新增的回归测试

| 测试组         | 最低覆盖                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| Session 状态机 | 三个并发 submit、cancel-before-approval、cancel-between-tools、close-with-active-run |
| Compaction     | 双 compact、compact + submit、close during compact、history revision 冲突            |
| Approval       | 同批 2 个 ask、响应失败重试、重复响应、旧 epoch 响应                                 |
| Event          | 重复投递、乱序、断线续传、checkpoint restore epoch、未知 schemaVersion               |
| Permission     | blocked MCP × 所有 mode、Bash 伪只读命令、restore 后 rules/trust 不变                |
| File           | 两 Session 编辑同一路径、多文件第二项失败、检查后外部写入                            |
| Persistence    | `SQLITE_BUSY`、事务中途失败、delete/restore race、audit append 失败重试              |
| Process        | MCP/LSP 双 connect、close during connect、sidecar crash/restart、进程树清理          |
| Client         | A→B 快切、旧请求晚到、SSE replay、录音 stop/start generation                         |

时序测试应优先使用 barrier / deferred Promise 控制事件顺序，不要依赖增加 `setTimeout()` 来“降低复现概率”。

### 本轮验证结果

- Tool Runtime：typecheck、lint 通过；聚焦 session/scheduler/watcher 测试 22/22 通过。
- Web + CLI：47/47 测试通过。
- Desktop Rust：17/17 测试通过。
- Server：typecheck 通过；测试 103 pass / 2 fail。失败均为 restore/checkpoint response 已新增 `history`、`permissionMode`，测试仍断言旧响应 shape，说明当前 Contract 与测试基线已经漂移。

现有测试通过不反驳本报告，因为它们主要覆盖 happy path，尚未覆盖上述交错时序、锁失败、重复投递和生命周期替换。
