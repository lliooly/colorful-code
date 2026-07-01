# Agent 前端实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 基于现有 Agent 后端 API，将 `apps/web` 从调试页升级为可日常使用的 Agent 工作台。

**架构：** 前端以 `Session` 为核心状态边界：REST 负责创建、恢复、消息提交、控制和检查点操作，SSE 负责驱动运行态、流式消息、工具调用、审批和编辑提案。UI 分成「会话 Shell」「聊天流」「审批中心」「编辑提案」「检查点」「高级状态面板」几个独立模块，避免继续把所有逻辑堆在单个页面组件中。

**技术栈：** Next.js App Router、React、TypeScript、shadcn/ui、本地 `fetch` API、浏览器 `EventSource`。

---

## 参考文档

- API 文档：`docs/superpowers/guides/2026-07-01-agent-api.md`
- 当前调试页：`apps/web/app/agent/page.tsx`
- 当前 API 封装：`apps/web/app/agent/api.ts`
- 当前前端类型：`apps/web/app/agent/types.ts`
- 后端 Controller：`apps/server/src/sessions/sessions.controller.ts`
- 后端事件类型：`packages/tool-runtime/src/session/events.ts`

---

## 产品范围

### 必须完成

- 创建会话、恢复会话、关闭会话。
- 发送用户消息，展示流式 assistant 回复。
- 展示 run 状态，支持取消当前 run。
- 展示工具调用和工具结果，默认折叠。
- 处理 `approval_required`，支持 allow / deny。
- 处理 `edit_proposed`，展示文件 diff，支持 approve / reject。
- 展示检查点列表，支持 restore / fork。
- 支持模型 preset 与 custom 配置。
- 支持权限模式切换。
- 支持 SSE 断线重连状态展示。

### 应该完成

- 展示 MCP / LSP 连接状态，但放在高级面板。
- 展示 todos、usage、context compaction 和 file events。
- 支持读取 snapshot，恢复历史 conversation。
- 支持读取 audit，展示权限决策记录。

### 暂不纳入

- 用户账号体系。
- 远程团队协作。
- 持久化前端本地设置到云端。
- 自定义主题系统。
- 后端接口改造。

---

## 建议文件结构

以下路径是建议拆分，不要求和现有调试页一一对应。实现时优先保持小文件、清晰职责。

```text
apps/web/app/agent/page.tsx
apps/web/app/agent/types.ts
apps/web/app/agent/api.ts
apps/web/app/agent/session-reducer.ts
apps/web/app/agent/use-agent-session.ts
apps/web/app/agent/components/agent-shell.tsx
apps/web/app/agent/components/session-toolbar.tsx
apps/web/app/agent/components/model-config-form.tsx
apps/web/app/agent/components/message-composer.tsx
apps/web/app/agent/components/conversation-list.tsx
apps/web/app/agent/components/conversation-item.tsx
apps/web/app/agent/components/tool-call-card.tsx
apps/web/app/agent/components/approval-panel.tsx
apps/web/app/agent/components/edit-proposals-panel.tsx
apps/web/app/agent/components/file-diff-view.tsx
apps/web/app/agent/components/checkpoints-panel.tsx
apps/web/app/agent/components/advanced-status-panel.tsx
apps/web/app/agent/components/json-viewer.tsx
apps/web/app/agent/__tests__/session-reducer.test.ts
```

职责说明：

| 文件 | 职责 |
| --- | --- |
| `page.tsx` | 页面入口，只组合 hook 和 shell |
| `types.ts` | 前端 wire types，与 API 文档保持一致 |
| `api.ts` | REST 和 SSE URL 封装 |
| `session-reducer.ts` | 纯函数处理 SSE 事件到 UI 状态 |
| `use-agent-session.ts` | 管理 session 生命周期、EventSource 和 API 调用 |
| `agent-shell.tsx` | 页面布局 |
| `session-toolbar.tsx` | 顶部状态、权限模式、取消、关闭 |
| `model-config-form.tsx` | 创建会话前的模型配置 |
| `message-composer.tsx` | 输入框和发送按钮 |
| `conversation-list.tsx` | 消息列表容器 |
| `conversation-item.tsx` | 用户、assistant、thinking 和系统事件展示 |
| `tool-call-card.tsx` | 工具调用和结果展示 |
| `approval-panel.tsx` | 权限审批 UI |
| `edit-proposals-panel.tsx` | 编辑提案列表和决策按钮 |
| `file-diff-view.tsx` | 单文件 diff 展示 |
| `checkpoints-panel.tsx` | 检查点列表、restore、fork |
| `advanced-status-panel.tsx` | MCP、LSP、audit、usage、raw log |
| `json-viewer.tsx` | JSON 展示小组件 |
| `session-reducer.test.ts` | 事件折叠逻辑测试 |

---

## 数据模型设计

### UI 状态

实现时建议先建立单一 reducer，所有 SSE 事件先进入 reducer，再由组件读取状态。

```ts
export type AgentSessionState = {
  sessionId: string | null;
  connected: boolean;
  connecting: boolean;
  runStatus: 'running' | 'completed' | 'cancelled' | 'error' | null;
  error: string | null;
  conversation: ConversationItem[];
  approvals: ApprovalState[];
  editProposals: EditProposalRecord[];
  checkpoints: Checkpoint[];
  currentCheckpointId: string | null;
  mcpServers: McpServerStatus[];
  lspServers: LspServerStatus[];
  todos: TodoItem[];
  usageByRunId: Record<string, { inputTokens?: number; outputTokens?: number }>;
  rawLog: Array<{ seq: number; event: SessionEvent }>;
};
```

### ConversationItem

```ts
export type ConversationItem =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      runId: string;
      text: string;
      thinking: string;
      finalized: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      runId: string;
      toolUseId: string;
      name: string;
      input: JsonObject;
      source?: ToolInvocationSource;
      result?: {
        content: string;
        isError: boolean;
        source?: ToolInvocationSource;
      };
    };
```

---

## 任务 1：补齐 API 类型与客户端封装

**文件：**

- 修改：`apps/web/app/agent/types.ts`
- 修改：`apps/web/app/agent/api.ts`
- 测试：可先不加单测，后续 reducer 测试覆盖主要行为

- [ ] **步骤 1：补齐 `ModelConfig` 字段**

在 `apps/web/app/agent/types.ts` 中扩展模型配置：

```ts
export type ModelConfig = {
  preset?: string;
  model?: string;
  baseURL?: string;
  protocol?: ModelProtocol;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: 'adaptive' | 'disabled';
};
```

- [ ] **步骤 2：补齐 create / restore 请求类型**

```ts
export type CreateSessionRequest = {
  permissionMode?: PermissionMode;
  workspaceRoots?: string[];
  rules?: PermissionRule[];
  cwd?: string;
  watchWorkspace?: boolean;
  model?: ModelConfig;
  mcpServers?: McpServersConfig;
  lspServers?: LspServersConfig;
};

export type RestoreSessionRequest = {
  model?: ModelConfig;
  mcpServers?: McpServersConfig;
  lspServers?: LspServersConfig;
  watchWorkspace?: boolean;
};
```

- [ ] **步骤 3：新增 snapshot、audit、restore session、delete session API**

在 `apps/web/app/agent/api.ts` 中增加：

```ts
export async function restoreSession(
  sessionId: string,
  req: RestoreSessionRequest = {},
): Promise<string> {
  const res = await postJson(
    `/sessions/${encodeURIComponent(sessionId)}/restore`,
    req,
  );
  const data = (await res.json()) as { id?: unknown };
  if (typeof data.id !== 'string') {
    throw new Error('POST /sessions/:id/restore did not return a string id.');
  }
  return data.id;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `DELETE /sessions/:id failed: ${String(res.status)} ${res.statusText}${
        detail ? ` - ${detail}` : ''
      }`,
    );
  }
}

export async function getSnapshot(
  sessionId: string,
): Promise<SessionSnapshot> {
  const res = await getJson(
    `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
  );
  return (await res.json()) as SessionSnapshot;
}

export async function getAudit(
  sessionId: string,
): Promise<{ entries: PermissionAuditEntry[] }> {
  const res = await getJson(`/sessions/${encodeURIComponent(sessionId)}/audit`);
  return (await res.json()) as { entries: PermissionAuditEntry[] };
}
```

- [ ] **步骤 4：运行类型检查**

运行：

```bash
pnpm --filter @colorful-code/web typecheck
```

如果该 package 没有 `typecheck` 脚本，运行：

```bash
pnpm --filter @colorful-code/web lint
```

预期：没有 TypeScript 或 ESLint 错误。

---

## 任务 2：抽出 Session Reducer

**文件：**

- 创建：`apps/web/app/agent/session-reducer.ts`
- 创建：`apps/web/app/agent/__tests__/session-reducer.test.ts`
- 修改：`apps/web/app/agent/page.tsx`

- [ ] **步骤 1：定义 reducer action**

```ts
export type AgentSessionAction =
  | { type: 'reset'; seedConversation?: ConversationItem[] }
  | { type: 'set_session'; sessionId: string | null }
  | { type: 'set_connected'; connected: boolean }
  | { type: 'set_error'; error: string | null }
  | { type: 'set_checkpoints'; checkpoints: Checkpoint[]; currentCheckpointId?: string }
  | { type: 'event'; event: SessionEvent };
```

- [ ] **步骤 2：实现事件折叠规则**

必须覆盖这些事件：

- `mcp_status`：更新 `mcpServers`
- `lsp_status`：更新 `lspServers`
- `run_status`：更新 `runStatus`
- `message_delta`：按 `runId` 拼接 assistant 消息
- `thinking_delta`：按 `runId` 拼接 thinking
- `message`：按 `runId` finalize assistant 消息
- `tool_call`：追加 tool item
- `tool_result`：按 `toolUseId` 附加结果
- `approval_required`：追加或替换 approval
- `edit_*`：upsert edit proposal 状态
- `todos_updated`：更新 todos
- `usage`：更新 usageByRunId
- `error`：设置 error

- [ ] **步骤 3：编写 reducer 单测**

至少覆盖：

```ts
it('appends message deltas and finalizes the assistant message', () => {});
it('attaches tool results by toolUseId', () => {});
it('records an approval_required event', () => {});
it('upserts edit proposal status transitions', () => {});
it('updates checkpoints from set_checkpoints action', () => {});
```

- [ ] **步骤 4：运行测试**

运行：

```bash
pnpm --filter @colorful-code/web test
```

如果 web package 暂无测试脚本，先运行：

```bash
pnpm --filter @colorful-code/web lint
```

预期：新增 reducer 代码没有 lint 错误。

---

## 任务 3：实现 `useAgentSession`

**文件：**

- 创建：`apps/web/app/agent/use-agent-session.ts`
- 修改：`apps/web/app/agent/page.tsx`

- [ ] **步骤 1：封装 EventSource 生命周期**

Hook 需要暴露：

```ts
export type UseAgentSessionResult = {
  state: AgentSessionState;
  create: (req: CreateSessionRequest) => Promise<void>;
  restore: (sessionId: string, req?: RestoreSessionRequest) => Promise<void>;
  close: () => Promise<void>;
  send: (text: string) => Promise<void>;
  sendControl: (message: ControlMessage) => Promise<void>;
  refreshCheckpoints: () => Promise<void>;
  restoreCheckpoint: (checkpointId: string, req?: RestoreSessionRequest) => Promise<void>;
  forkCheckpoint: (checkpointId: string, req?: RestoreSessionRequest) => Promise<void>;
};
```

- [ ] **步骤 2：打开 SSE 时注册所有具名事件**

```ts
for (const eventType of SESSION_EVENT_TYPES) {
  source.addEventListener(eventType, (raw: MessageEvent<string>) => {
    const event = JSON.parse(raw.data) as SessionEvent;
    dispatch({ type: 'event', event });
  });
}
```

- [ ] **步骤 3：处理断线状态**

- `source.onopen` 设置 `connected: true`
- `source.onerror` 设置 `connected: false`
- 不要在 `onerror` 中清空会话，浏览器会自动重连

- [ ] **步骤 4：运行类型检查或 lint**

运行：

```bash
pnpm --filter @colorful-code/web lint
```

预期：无 lint 错误。

---

## 任务 4：搭建产品化 Shell

**文件：**

- 创建：`apps/web/app/agent/components/agent-shell.tsx`
- 创建：`apps/web/app/agent/components/session-toolbar.tsx`
- 创建：`apps/web/app/agent/components/model-config-form.tsx`
- 修改：`apps/web/app/agent/page.tsx`

- [ ] **步骤 1：让 `page.tsx` 只负责组合**

目标结构：

```tsx
export default function AgentPage(): ReactNode {
  const session = useAgentSession();

  return (
    <AgentShell
      state={session.state}
      onCreate={session.create}
      onRestore={session.restore}
      onClose={session.close}
      onSendControl={session.sendControl}
    />
  );
}
```

- [ ] **步骤 2：设计首屏布局**

首屏应该直接是可用工作台，不做营销式 landing page。推荐布局：

- 顶栏：模型、权限、session 状态、运行状态、取消按钮。
- 主区域：左侧 conversation，右侧上下文面板。
- 底部：message composer。
- 右侧面板 tabs：审批、编辑、检查点、高级。

- [ ] **步骤 3：创建会话前展示模型配置**

`model-config-form.tsx` 支持：

- preset：`claude`、`deepseek`、`openai`、`custom`
- custom protocol：`anthropic`、`openai`
- baseURL
- model
- apiKey
- maxTokens
- temperature
- thinking：`adaptive`、`disabled`
- cwd
- workspaceRoots
- watchWorkspace

- [ ] **步骤 4：验证响应式**

运行 dev server：

```bash
pnpm --filter @colorful-code/web dev
```

在桌面和移动宽度检查：

- 文本不溢出按钮。
- 右侧面板在窄屏变成下方 tabs。
- composer 不遮挡消息列表。

---

## 任务 5：实现聊天流

**文件：**

- 创建：`apps/web/app/agent/components/message-composer.tsx`
- 创建：`apps/web/app/agent/components/conversation-list.tsx`
- 创建：`apps/web/app/agent/components/conversation-item.tsx`
- 创建：`apps/web/app/agent/components/tool-call-card.tsx`

- [ ] **步骤 1：Message composer**

要求：

- 未创建 session 时禁用。
- `runStatus === 'running'` 时允许继续输入，但发送按钮可按产品判断禁用。
- 支持 Enter 发送，Shift + Enter 换行。
- 发送后立即清空输入。
- 发送失败时恢复草稿或显示错误。

- [ ] **步骤 2：Conversation list**

要求：

- 用户消息、assistant 消息、tool item 样式区分。
- `message_delta` 期间显示 streaming 状态。
- `thinking` 默认折叠。
- 工具调用默认折叠，错误结果高亮。
- 新消息自动滚动到底部，但用户手动上滚时不要强制抢滚动。

- [ ] **步骤 3：Tool card**

展示字段：

- tool name
- source：builtin / lsp / mcp server
- input JSON
- result content
- isError

- [ ] **步骤 4：验证最小聊天闭环**

手动流程：

1. 创建 session。
2. 连接 SSE。
3. 发送消息。
4. 看到 `run_status: running`。
5. 看到 `message_delta` 或 `tool_call`。
6. 看到 terminal `run_status`。

---

## 任务 6：实现审批中心

**文件：**

- 创建：`apps/web/app/agent/components/approval-panel.tsx`
- 修改：`apps/web/app/agent/use-agent-session.ts`

- [ ] **步骤 1：展示审批请求**

从 `approval_required` 渲染：

- message
- tool name
- source
- input JSON
- suggestions

- [ ] **步骤 2：实现 allow / deny**

调用：

```ts
sendControl({
  type: 'approval_response',
  requestId,
  decision: { behavior: 'allow' },
});
```

拒绝：

```ts
sendControl({
  type: 'approval_response',
  requestId,
  decision: {
    behavior: 'deny',
    message: 'Denied from UI.',
  },
});
```

- [ ] **步骤 3：支持 updatedInput**

高级模式可允许编辑 input JSON。提交前必须保证它是 JSON object，不允许数组或原始值。

- [ ] **步骤 4：验证 parked run 恢复**

手动构造一个需要审批的操作，确认 allow 后 run 继续，deny 后 run 收到拒绝结果。

---

## 任务 7：实现编辑提案与 Diff

**文件：**

- 创建：`apps/web/app/agent/components/edit-proposals-panel.tsx`
- 创建：`apps/web/app/agent/components/file-diff-view.tsx`

- [ ] **步骤 1：展示提案列表**

每个 proposal 展示：

- proposalId
- runId
- toolUseId
- status：proposed / approved / applied / rejected / conflict
- affected files count
- reason 或 conflictReason

- [ ] **步骤 2：展示文件 diff**

`FilePatch` 渲染要求：

- 文件路径。
- added / removed 统计。
- hunk header。
- context / added / removed 三种行样式。
- oldNumber / newNumber 行号。

- [ ] **步骤 3：实现 approve / reject**

```ts
sendControl({
  type: 'edit_decision',
  proposalId,
  decision: 'approve',
});
```

```ts
sendControl({
  type: 'edit_decision',
  proposalId,
  decision: 'reject',
  reason: 'Rejected from UI.',
});
```

- [ ] **步骤 4：验证状态流转**

需要确认 UI 能处理：

- `edit_proposed` → `edit_approved` → `edit_applied`
- `edit_proposed` → `edit_rejected`
- `edit_proposed` → `edit_conflict`

---

## 任务 8：实现检查点

**文件：**

- 创建：`apps/web/app/agent/components/checkpoints-panel.tsx`
- 修改：`apps/web/app/agent/use-agent-session.ts`

- [ ] **步骤 1：运行结束后刷新检查点**

当收到以下状态时调用 `listCheckpoints`：

- `completed`
- `cancelled`
- `error`

- [ ] **步骤 2：展示检查点**

字段：

- label
- summary
- createdAt
- runId
- current 标记
- fileChanges（存在时展示）

- [ ] **步骤 3：实现 restore**

调用 `POST /sessions/:id/checkpoints/:checkpointId/restore` 后：

- sessionId 保持不变。
- 用 checkpoint.snapshot.history 重建 conversation。
- 重新打开 SSE。
- 刷新 currentCheckpointId。

- [ ] **步骤 4：实现 fork**

调用 `POST /sessions/:id/checkpoints/:checkpointId/fork` 后：

- 切换到响应里的新 sessionId。
- 用来源 checkpoint.snapshot.history 重建 conversation。
- 重新打开 SSE。
- 刷新新 session 的 checkpoints。

---

## 任务 9：实现高级状态面板

**文件：**

- 创建：`apps/web/app/agent/components/advanced-status-panel.tsx`
- 创建：`apps/web/app/agent/components/json-viewer.tsx`

- [ ] **步骤 1：MCP 状态**

展示：

- server name
- status
- transport
- tools
- resources
- instructions
- error

- [ ] **步骤 2：LSP 状态**

展示：

- server name
- language
- fileExtensions
- status
- error

- [ ] **步骤 3：Todos、Usage、Compaction**

展示：

- 最新 todos。
- 每个 run 的 inputTokens / outputTokens。
- context_compacted 的 before / after / entriesSummarized。

- [ ] **步骤 4：Audit 与 raw log**

支持用户手动刷新 audit：

```ts
const audit = await getAudit(sessionId);
```

raw log 默认折叠，仅用于调试。

---

## 任务 10：可用性与视觉打磨

**文件：**

- 修改：`apps/web/app/globals.css`
- 修改：`apps/web/app/agent/components/*.tsx`

- [ ] **步骤 1：整理信息密度**

这是工作台，不是营销页。避免大 hero、大装饰卡片和过重渐变。界面应优先服务于阅读代码、审批、对话和 diff。

- [ ] **步骤 2：按钮和状态图标**

常用操作使用 icon button 或 icon + text：

- 取消 run
- 刷新检查点
- 展开 / 折叠工具调用
- 展开 / 折叠 thinking
- 关闭 session

- [ ] **步骤 3：移动端布局**

移动端要求：

- 顶栏不换出屏幕。
- composer 始终可用。
- 右侧面板改为底部 tabs 或抽屉。
- diff 支持横向滚动。

- [ ] **步骤 4：空状态与错误状态**

必须有明确状态：

- 未创建 session
- SSE offline
- run error
- MCP / LSP failed
- 无 checkpoints
- 无 edit proposals
- 无 audit entries

---

## 任务 11：最终验证

**文件：**

- 修改：按实际实现涉及文件

- [ ] **步骤 1：静态检查**

运行：

```bash
pnpm --filter @colorful-code/web lint
```

预期：通过。

- [ ] **步骤 2：类型检查**

如果 package 有 typecheck 脚本，运行：

```bash
pnpm --filter @colorful-code/web typecheck
```

预期：通过。

- [ ] **步骤 3：后端联调**

分别启动：

```bash
pnpm --filter @colorful-code/server start:dev
```

```bash
pnpm --filter @colorful-code/web dev
```

手动验证：

- 创建 session 成功。
- SSE connected。
- 发送消息后出现 run 状态变化。
- assistant 文本流式展示。
- 工具调用能展示。
- 审批能 allow / deny。
- 编辑提案能 approve / reject。
- 检查点能 restore / fork。
- 关闭 session 后 SSE 关闭。

- [ ] **步骤 4：回归当前调试能力**

确认旧调试页已有能力没有丢失：

- MCP server 状态。
- LSP server 状态。
- raw event log。
- hook warning。
- file events。

---

## 交付标准

前端完成后应满足：

- 普通用户可以只看聊天、审批、diff 和检查点完成日常使用。
- 高级用户可以打开状态面板查看 MCP、LSP、audit 和 raw log。
- 页面不依赖后端返回同步运行结果，所有运行态都从 SSE 驱动。
- API 类型与 `docs/superpowers/guides/2026-07-01-agent-api.md` 保持一致。
- `apiKey` 只在创建或恢复请求中发送，不进入 React state 之外的长期持久化。
- SSE 断线不清空会话，重连后能接收后端 replay。
