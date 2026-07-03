# Unified Plugin Catalog 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有 MCP-only 插件中心扩展为统一管理 MCP、Skills、LSP 的内部 Plugin Hub。

**架构：** 复用现有 `PluginsModule` 和 `installed_plugins` 表，把 `PluginStore` 从 MCP-only 类型收窄中释放出来。MCP 继续走官方 Registry；Skills 和 LSP 使用 curated catalog；enabled LSP 插件合并进 session 的 `lspServers`。

**技术栈：** NestJS, Bun node:test, SQLite/Drizzle, Next.js client component, existing MCP/LSP config runtime.

---

## 文件结构

- 修改：`apps/server/src/plugins/plugin-types.ts`：新增 `PluginKind`、Skill/LSP catalog/config 类型，把 `InstalledPlugin` 泛化为三种 kind。
- 修改：`apps/server/src/plugins/plugin-registry.ts`：保留 MCP Registry 逻辑，导出 MCP catalog item 转换辅助。
- 创建：`apps/server/src/plugins/plugin-catalog.ts`：内置 Skill/LSP curated catalog 和查找函数。
- 修改：`apps/server/src/plugins/plugin-store.ts`：新增 generic install 方法、`enabledLspServers()`，保留 `installMcpPlugin()` 兼容测试和调用者。
- 修改：`apps/server/src/plugins/plugins.service.ts`：按 `kind` 安装 MCP/Skill/LSP；增加 curated catalog list。
- 修改：`apps/server/src/plugins/plugins.controller.ts`：新增 `/plugins/registry/skills` 和 `/plugins/registry/lsp`。
- 修改：`apps/server/src/sessions/sessions.service.ts`：把 enabled installed LSP 插件合并到 `resolveLspServers()`。
- 修改：`apps/server/test/plugins.test.ts`：TDD 覆盖 Skill/LSP catalog 和安装管理。
- 修改：`apps/server/test/plugin-session-merge.test.ts`：TDD 覆盖 enabled/disabled LSP session merge。
- 修改：`apps/web/app/agent/types.ts`：泛化插件类型，新增 Skill/LSP registry types。
- 修改：`apps/web/app/agent/api.ts`：新增 list skill/lsp catalog API helper，install request 增加 kind。
- 修改：`apps/web/app/agent/page.tsx`：插件卡片增加 kind filter，展示 MCP/Skills/LSP，MCP-only trust 控制。

## 任务 1：后端类型、catalog、store

**文件：**

- 修改：`apps/server/src/plugins/plugin-types.ts`
- 创建：`apps/server/src/plugins/plugin-catalog.ts`
- 修改：`apps/server/src/plugins/plugin-store.ts`
- 测试：`apps/server/test/plugins.test.ts`

- [x] **步骤 1：编写失败的 catalog/store 测试**

在 `apps/server/test/plugins.test.ts` 添加：

```ts
import {
  listLspCatalog,
  listSkillCatalog,
} from '../src/plugins/plugin-catalog';

test('curated catalogs expose skill and LSP plugin entries', () => {
  assert.ok(listSkillCatalog().some((item) => item.kind === 'skill'));
  assert.ok(listLspCatalog().some((item) => item.kind === 'lsp'));
});

test('PluginStore persists skill and LSP plugins separately', () => {
  const store = PluginStore.openAt(':memory:');
  try {
    const skill = store.installCatalogPlugin({
      kind: 'skill',
      registryName: 'github:colorful-code/skills/code-review',
      title: 'Code Review Skill',
      version: 'latest',
      config: {
        type: 'skill',
        source: 'github',
        repository: 'colorful-code/skills',
        path: 'code-review',
        entry: 'SKILL.md',
        installHint: 'Install into a configured skill root.',
      },
    });
    const lsp = store.installCatalogPlugin({
      kind: 'lsp',
      registryName: 'typescript-language-server',
      title: 'TypeScript LSP',
      version: 'latest',
      config: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        language: 'typescript',
        fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
      },
    });

    assert.equal(skill.kind, 'skill');
    assert.equal(lsp.kind, 'lsp');
    assert.equal(
      store.enabledLspServers().typescript?.command,
      'typescript-language-server',
    );
  } finally {
    store.close();
  }
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts`

预期：FAIL，原因是 `plugin-catalog`、`installCatalogPlugin`、`enabledLspServers` 尚不存在。

- [x] **步骤 3：实现类型、catalog 和 store**

实现：

```ts
export type PluginKind = 'mcp' | 'skill' | 'lsp';
export type SkillPluginConfig = {
  type: 'skill';
  source: 'github' | 'local';
  repository?: string;
  path: string;
  entry: string;
  installHint?: string;
};
export type LspPluginConfig = LspServerConfig;
export type InstalledPluginConfig =
  | McpServerConfigWithTrust
  | SkillPluginConfig
  | LspPluginConfig;
```

`plugin-catalog.ts` 提供至少两个 skill 示例和四个 LSP 示例：TypeScript、Rust、Go、Python。`PluginStore.installCatalogPlugin()` 写入 `kind:${registryName}` 作为 id。`enabledLspServers()` 只返回 enabled 且 `kind === 'lsp'` 的 config。

- [x] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts`

预期：PASS。

## 任务 2：后端 API 和 session merge

**文件：**

- 修改：`apps/server/src/plugins/plugins.service.ts`
- 修改：`apps/server/src/plugins/plugins.controller.ts`
- 修改：`apps/server/src/sessions/sessions.service.ts`
- 测试：`apps/server/test/plugins.test.ts`
- 测试：`apps/server/test/plugin-session-merge.test.ts`

- [x] **步骤 1：编写失败的 API 和 session 测试**

在 `plugins.test.ts` 添加：

```ts
test('plugins API lists and installs curated skill and LSP plugins', async () => {
  const app = await boot();
  const fastify = app.getHttpAdapter().getInstance();

  const skills = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/skills',
  });
  assert.equal(skills.statusCode, 200);
  const skillName = skills.json<{ plugins: Array<{ name: string }> }>()
    .plugins[0]?.name;
  assert.ok(skillName);

  const skillInstall = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { kind: 'skill', registryName: skillName },
  });
  assert.equal(skillInstall.statusCode, 201);
  assert.equal(skillInstall.json<{ kind: string }>().kind, 'skill');

  const lsp = await fastify.inject({
    method: 'GET',
    url: '/plugins/registry/lsp',
  });
  assert.equal(lsp.statusCode, 200);
  const lspName = lsp.json<{ plugins: Array<{ name: string }> }>().plugins[0]
    ?.name;
  assert.ok(lspName);

  const lspInstall = await fastify.inject({
    method: 'POST',
    url: '/plugins/install',
    payload: { kind: 'lsp', registryName: lspName },
  });
  assert.equal(lspInstall.statusCode, 201);
  assert.equal(lspInstall.json<{ kind: string }>().kind, 'lsp');
});
```

在 `plugin-session-merge.test.ts` 添加 enabled/disabled LSP 测试，断言 `lsp_status` 里出现或不出现安装的 LSP server。

- [x] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts plugin-session-merge.test.ts`

预期：FAIL，原因是 API endpoints 和 LSP merge 尚不存在。

- [x] **步骤 3：实现 API 和 session merge**

`PluginsService.install()` 中 `kind` 缺省为 `mcp`。`skill` 和 `lsp` 从 curated catalog 查找，找不到抛 `NotFoundException`。`resolveLspServers()` 增加 `this.pluginStore?.enabledLspServers()`，顺序放在 env 之后、request overrides 之前。

- [x] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @colorful-code/server test -- plugins.test.ts plugin-session-merge.test.ts`

预期：PASS。

## 任务 3：前端插件卡片

**文件：**

- 修改：`apps/web/app/agent/types.ts`
- 修改：`apps/web/app/agent/api.ts`
- 修改：`apps/web/app/agent/page.tsx`

- [x] **步骤 1：更新前端 wire types 和 API helper**

新增：

```ts
export type PluginKind = 'mcp' | 'skill' | 'lsp';
export type CatalogPlugin = {
  kind: PluginKind;
  name: string;
  title?: string;
  description?: string;
  version?: string;
  config?: JsonObject;
};
export type ListCatalogPluginsResponse = { plugins: CatalogPlugin[] };
```

新增 helpers：

```ts
export async function listSkillRegistryPlugins(): Promise<ListCatalogPluginsResponse>;
export async function listLspRegistryPlugins(): Promise<ListCatalogPluginsResponse>;
```

- [x] **步骤 2：更新插件 dialog state 和 loading**

在 `page.tsx` 中增加 `skillPlugins`、`lspPlugins`、`pluginKindFilter`。`refreshPlugins()` 并发请求 MCP registry、skills catalog、lsp catalog、installed list。构造统一 `catalogPlugins`。

- [x] **步骤 3：更新卡片 UI**

插件 dialog 顶部增加 All/MCP/Skills/LSP 分段按钮。Registry 卡片按 filter 展示三类插件。Install 按钮发送 `{ kind, registryName }`。Installed 管理区显示 kind badge；只有 MCP 渲染 Trust select，Skills/LSP 只显示 Enabled 和 Delete。

- [x] **步骤 4：运行前端验证**

运行：

```bash
pnpm --filter @colorful-code/web lint
pnpm --filter @colorful-code/web typecheck
pnpm exec prettier --check apps/web/app/agent/page.tsx apps/web/app/agent/api.ts apps/web/app/agent/types.ts
```

预期：全部 PASS。

## 任务 4：最终核查

**文件：**

- 全部变更文件

- [x] **步骤 1：运行后端全量验证**

运行：

```bash
pnpm --filter @colorful-code/server test
pnpm --filter @colorful-code/server lint
```

预期：全部 PASS。

- [x] **步骤 2：运行前端验证**

运行：

```bash
pnpm --filter @colorful-code/web lint
pnpm --filter @colorful-code/web typecheck
pnpm exec prettier --check apps/server/src/plugins/plugin-types.ts apps/server/src/plugins/plugin-catalog.ts apps/server/src/plugins/plugin-store.ts apps/server/src/plugins/plugins.service.ts apps/server/src/plugins/plugins.controller.ts apps/server/src/sessions/sessions.service.ts apps/server/test/plugins.test.ts apps/server/test/plugin-session-merge.test.ts apps/web/app/agent/types.ts apps/web/app/agent/api.ts apps/web/app/agent/page.tsx docs/superpowers/specs/2026-07-03-unified-plugin-catalog-design.md docs/superpowers/plans/2026-07-03-unified-plugin-catalog.md
git diff --check
```

预期：全部 PASS。

- [x] **步骤 3：人工 review 清单**

核查：

- MCP install 不破坏旧 payload。
- Skill/LSP install 不执行外部下载。
- disabled LSP 不进入 session。
- request-level LSP override 仍然最后生效。
- 前端 Trust 只出现在 MCP installed card。
