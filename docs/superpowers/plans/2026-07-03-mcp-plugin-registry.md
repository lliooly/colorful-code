# MCP Plugin Registry 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个轻量 MCP 插件市场，让内部用户直接浏览 MCP Registry、安装 MCP server、启用关闭卸载，并让启用的插件自动进入 agent session。

**架构：** 后端新增 `PluginsModule`，作为 MCP Registry 的薄代理和本地安装清单管理层。`SessionsService` 在解析 MCP 配置时合并启用的已安装插件。前端复用现有 `Puzzle` sidebar 入口，提供插件浏览和已安装插件管理。

**技术栈：** NestJS, Bun test, SQLite/Drizzle, Next.js client component, existing MCP config/runtime.

---

## 文件结构

- 创建：`apps/server/src/plugins/plugin-types.ts`，定义 registry 响应、安装请求、已安装插件类型。
- 创建：`apps/server/src/plugins/plugin-registry.ts`，封装 MCP Registry fetch 和 registry package 到 `McpServerConfig` 的转换。
- 创建：`apps/server/src/plugins/plugin-store.ts`，SQLite persistence 边界，负责 installed plugin CRUD。
- 创建：`apps/server/src/plugins/plugins.service.ts`，编排 registry、store、安装和更新逻辑。
- 创建：`apps/server/src/plugins/plugins.controller.ts`，提供 `/plugins/*` HTTP API。
- 创建：`apps/server/src/plugins/plugins.module.ts`，导出 `PluginsService` 给 `SessionsModule`。
- 修改：`apps/server/src/persistence/schema.ts`，新增 `installed_plugins` 表和 DDL。
- 修改：`apps/server/src/app.module.ts`，导入 `PluginsModule`。
- 修改：`apps/server/src/sessions/sessions.module.ts`，导入 `PluginsModule`。
- 修改：`apps/server/src/sessions/sessions.service.ts`，将 enabled installed MCP configs 纳入 `resolveMcpServers`。
- 创建：`apps/server/test/plugins.test.ts`，覆盖转换和 CRUD。
- 创建：`apps/server/test/plugin-session-merge.test.ts`，覆盖 session 合成。
- 修改：`apps/web/app/agent/types.ts`，新增 plugin API wire types。
- 修改：`apps/web/app/agent/api.ts`，新增 plugin API helpers。
- 修改：`apps/web/app/agent/page.tsx`，把 sidebar `plugins` 入口接到 MCP 插件面板和已安装管理。

## 任务 1：后端类型、转换和持久化

**文件：**

- 创建：`apps/server/src/plugins/plugin-types.ts`
- 创建：`apps/server/src/plugins/plugin-registry.ts`
- 创建：`apps/server/src/plugins/plugin-store.ts`
- 修改：`apps/server/src/persistence/schema.ts`
- 创建：`apps/server/test/plugins.test.ts`

- [ ] **步骤 1：编写失败的转换测试**

在 `apps/server/test/plugins.test.ts` 中添加：

```ts
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deriveMcpConfigFromRegistryServer } from '../src/plugins/plugin-registry';

test('deriveMcpConfigFromRegistryServer maps npm stdio packages to npx', () => {
  const config = deriveMcpConfigFromRegistryServer({
    name: 'io.example/demo',
    version: '1.0.0',
    packages: [
      {
        registryType: 'npm',
        identifier: '@example/demo-mcp',
        version: '1.0.0',
        transport: { type: 'stdio' },
      },
    ],
  });

  assert.deepEqual(config, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/demo-mcp'],
    trust: 'ask',
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts`

预期：FAIL，原因是 `../src/plugins/plugin-registry` 不存在。

- [ ] **步骤 3：实现最小转换代码**

创建 `plugin-types.ts` 和 `plugin-registry.ts`，实现 npm stdio、pypi stdio、http、sse 映射。不支持的 package 抛出 `Error('No supported MCP registry package found.')`。

- [ ] **步骤 4：补充持久化失败测试**

在 `plugins.test.ts` 中添加 `PluginStore.openAt(':memory:')` 的 install/list/update/delete 测试，断言 enabled 和 trust 能持久化。

- [ ] **步骤 5：运行持久化测试验证失败**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts`

预期：FAIL，原因是 `PluginStore` 或 `installed_plugins` 表不存在。

- [ ] **步骤 6：实现 store 和 schema**

在 `schema.ts` 新增 `installedPlugins` 表和 DDL。实现 `PluginStore`：`installMcpPlugin`、`listInstalled`、`updateInstalled`、`deleteInstalled`、`enabledMcpServers`、`openAt`、`close`。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts`

预期：PASS。

## 任务 2：后端 HTTP API 和 session 合成

**文件：**

- 创建：`apps/server/src/plugins/plugins.service.ts`
- 创建：`apps/server/src/plugins/plugins.controller.ts`
- 创建：`apps/server/src/plugins/plugins.module.ts`
- 修改：`apps/server/src/app.module.ts`
- 修改：`apps/server/src/sessions/sessions.module.ts`
- 修改：`apps/server/src/sessions/sessions.service.ts`
- 创建：`apps/server/test/plugin-session-merge.test.ts`

- [ ] **步骤 1：编写失败的 API 测试**

在 `apps/server/test/plugins.test.ts` 中补充 Nest app 测试：`POST /plugins/install` 使用 fake registry client 安装一个 npm stdio MCP，`GET /plugins/installed` 返回该插件，`PATCH` 可关闭，`DELETE` 后为空。

- [ ] **步骤 2：运行 API 测试验证失败**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts`

预期：FAIL，原因是 controller/module/service 不存在。

- [ ] **步骤 3：实现 API 最小代码**

实现 `PluginsService` 和 `PluginsController`。Registry list/detail 失败映射为 `BadGatewayException`；install/patch body 校验失败为 `BadRequestException`；未知 installed id 为 `NotFoundException`。

- [ ] **步骤 4：编写失败的 session 合成测试**

创建 `plugin-session-merge.test.ts`：注入 `PluginStore.openAt(':memory:')`，先安装 enabled fixture MCP，再 `POST /sessions` 不传 `mcpServers`，断言 `mcp_status` 包含该 fixture；将其 disabled 后新建 session，断言不包含该 fixture。

- [ ] **步骤 5：运行 session 合成测试验证失败**

运行：`pnpm --filter @colorful-code/server test -- plugin-session-merge.test.ts`

预期：FAIL，原因是 `SessionsService` 未合并 installed plugins。

- [ ] **步骤 6：实现 session 合成**

在 `SessionsService` 可选注入 `PluginsService` 或 `PluginStore`，`resolveMcpServers` 合并 `enabledMcpServers()`，顺序为 project/env/installed/request。

- [ ] **步骤 7：运行后端插件测试验证通过**

运行：

```bash
pnpm --filter @colorful-code/server test -- plugins.test.ts plugin-session-merge.test.ts
```

预期：PASS。

## 任务 3：前端插件入口和管理

**文件：**

- 修改：`apps/web/app/agent/types.ts`
- 修改：`apps/web/app/agent/api.ts`
- 修改：`apps/web/app/agent/page.tsx`

- [ ] **步骤 1：新增 wire types 和 API helpers**

在 `types.ts` 增加 `InstalledPlugin`、`McpRegistryServerSummary`、`McpRegistryServerDetail`。在 `api.ts` 增加 `listMcpRegistryServers`、`getMcpRegistryServer`、`listInstalledPlugins`、`installPlugin`、`updateInstalledPlugin`、`deleteInstalledPlugin`。

- [ ] **步骤 2：接通 sidebar plugins 入口**

在 `page.tsx` 中添加 `activeSidebarItem` state。点击 `sidebarItems` 的 `plugins` 打开 dialog/sheet/panel，不改变会话状态。

- [ ] **步骤 3：实现 MCP 插件面板**

面板加载 registry list 和 installed list。每个 registry 条目显示 name、title、description、version，未安装显示 install button，已安装显示 Installed badge。

- [ ] **步骤 4：实现已安装管理**

已安装列表支持 enable switch、trust select、delete button。更新成功后刷新 installed list。请求失败显示现有 alert/error 样式。

- [ ] **步骤 5：运行前端类型检查**

运行：`pnpm --filter @colorful-code/web typecheck`

预期：PASS。

## 任务 4：整体验证和代码审查

**文件：**

- 修改：计划中所有代码文件

- [ ] **步骤 1：运行后端测试**

运行：`pnpm --filter @colorful-code/server test`

预期：PASS。

- [ ] **步骤 2：运行前端类型检查**

运行：`pnpm --filter @colorful-code/web typecheck`

预期：PASS。

- [ ] **步骤 3：运行最终 diff 审查**

运行：`git diff --stat` 和 `git diff -- apps/server apps/web docs/superpowers`。检查：

- 没有真实 secrets。
- MCP trust 默认 `ask`。
- disabled installed plugins 不进入 session。
- request MCP overrides 保持最高优先级。
- unsupported registry package 有明确错误。

- [ ] **步骤 4：修复审查问题并重跑验证**

如果发现问题，修复后重跑步骤 1 和步骤 2。
