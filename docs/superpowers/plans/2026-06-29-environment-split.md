# Environment Split 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 server/web 的开发与生产环境配置分开，并让生产环境缺失关键配置时快速失败。

**架构：** 在 `apps/server/src/config` 增加一个无依赖的配置 helper，集中解析 `NODE_ENV`、监听地址、CORS allowlist 和 provider key 脱敏视图。`main.ts` 只负责加载开发 `.env`、创建 Nest/Fastify 应用、注册 CORS、按解析出的 host/port 启动。根、server、web package scripts 和 `turbo.json` 声明 dev/prod 任务与 env 传递规则。

**技术栈：** TypeScript、NestJS、Fastify CORS、Node `process.loadEnvFile`、Node test runner、pnpm、Turborepo。

---

## 文件结构

- 创建：`apps/server/src/config/environment.ts`
  - 负责解析和验证 server runtime env。
  - 导出 `loadServerEnvironment`, `toRedactedServerEnvironment`, `loadDevelopmentEnvFileIfPresent`。
- 创建：`apps/server/test/environment.test.ts`
  - 覆盖 dev defaults、PORT 校验、production CORS fail-fast、CORS 分割、secret 脱敏。
- 修改：`apps/server/src/main.ts`
  - 早期加载开发 `.env`，读取 server config，注册 CORS，按配置启动。
- 修改：`apps/server/package.json`
  - 增加 `start:prod`，保留 `start` 兼容。
- 修改：`apps/web/package.json`
  - 增加 `start:prod`。
- 修改：`package.json`
  - 增加根 `start:prod`。
- 修改：`turbo.json`
  - 声明 `NODE_ENV`、web build env、runtime pass-through env、`start:prod` 任务。
- 修改：`.gitignore`
  - 忽略 `.env` / `.env.local` / `.env.*.local` / app-level env 文件。
- 创建：`.env.example`
- 创建：`apps/server/.env.example`
- 创建：`apps/web/.env.example`
- 创建：`README.md`
  - 记录 env 文件、命令和生产注意事项。

## 任务 1：Server 环境解析 helper

**文件：**

- 创建：`apps/server/src/config/environment.ts`
- 创建：`apps/server/test/environment.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `apps/server/test/environment.test.ts` 写入：

```ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  loadServerEnvironment,
  toRedactedServerEnvironment,
} from '../src/config/environment';

test('loadServerEnvironment uses development-safe defaults', () => {
  const config = loadServerEnvironment({});
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.isProduction, false);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.deepEqual(config.corsOrigins, ['http://localhost:3000']);
});

test('loadServerEnvironment accepts a valid PORT', () => {
  const config = loadServerEnvironment({ PORT: '49152' });
  assert.equal(config.port, 49152);
});

test('loadServerEnvironment rejects an invalid PORT', () => {
  assert.throws(
    () => loadServerEnvironment({ PORT: 'abc' }),
    /PORT must be an integer between 1 and 65535/,
  );
});

test('loadServerEnvironment parses comma-separated CORS origins', () => {
  const config = loadServerEnvironment({
    CORS_ORIGIN: 'https://app.example.com, https://admin.example.com',
  });
  assert.deepEqual(config.corsOrigins, [
    'https://app.example.com',
    'https://admin.example.com',
  ]);
});

test('loadServerEnvironment requires CORS_ORIGIN in production', () => {
  assert.throws(
    () => loadServerEnvironment({ NODE_ENV: 'production' }),
    /CORS_ORIGIN is required when NODE_ENV=production/,
  );
});

test('loadServerEnvironment rejects malformed CORS origins', () => {
  assert.throws(
    () =>
      loadServerEnvironment({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://app.example.com,not-a-url',
      }),
    /CORS_ORIGIN entries must be absolute http\(s\) origins/,
  );
});

test('toRedactedServerEnvironment masks provider secrets', () => {
  const redacted = toRedactedServerEnvironment(
    loadServerEnvironment({
      ANTHROPIC_API_KEY: 'sk-ant-real',
      OPENAI_API_KEY: '',
      DEEPSEEK_API_KEY: 'deepseek-real',
    }),
  );

  assert.equal(redacted.providerKeys.anthropic, '[set]');
  assert.equal(redacted.providerKeys.openai, '[unset]');
  assert.equal(redacted.providerKeys.deepseek, '[set]');
  assert.equal(JSON.stringify(redacted).includes('sk-ant-real'), false);
  assert.equal(JSON.stringify(redacted).includes('deepseek-real'), false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/server test`

预期：TypeScript 编译失败，错误包含找不到 `../src/config/environment`。

- [ ] **步骤 3：编写最少实现代码**

创建 `apps/server/src/config/environment.ts`：

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

type NodeEnvironment = 'development' | 'production' | 'test';

type ProviderKeyName = 'anthropic' | 'openai' | 'deepseek';

type ProviderKeys = Record<ProviderKeyName, string | undefined>;

export interface ServerEnvironment {
  nodeEnv: NodeEnvironment;
  isProduction: boolean;
  host: string;
  port: number;
  corsOrigins: string[];
  providerKeys: ProviderKeys;
}

export interface RedactedServerEnvironment {
  nodeEnv: NodeEnvironment;
  isProduction: boolean;
  host: string;
  port: number;
  corsOrigins: string[];
  providerKeys: Record<ProviderKeyName, '[set]' | '[unset]'>;
}

type EnvironmentSource = NodeJS.ProcessEnv;

const defaultCorsOrigins = ['http://localhost:3000'];

export function loadDevelopmentEnvFileIfPresent(
  cwd = process.cwd(),
  env = process.env,
): void {
  if (env.NODE_ENV === 'production') {
    return;
  }

  const envPath = join(cwd, '.env');
  if (existsSync(envPath)) {
    loadEnvFile(envPath);
  }
}

export function loadServerEnvironment(
  env: EnvironmentSource = process.env,
): ServerEnvironment {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const isProduction = nodeEnv === 'production';
  const host = readNonEmpty(env.HOST) ?? '127.0.0.1';
  const port = parsePort(env.PORT);
  const corsOrigins = parseCorsOrigins(env.CORS_ORIGIN, isProduction);

  return {
    nodeEnv,
    isProduction,
    host,
    port,
    corsOrigins,
    providerKeys: {
      anthropic: readNonEmpty(env.ANTHROPIC_API_KEY),
      openai: readNonEmpty(env.OPENAI_API_KEY),
      deepseek: readNonEmpty(env.DEEPSEEK_API_KEY),
    },
  };
}

export function toRedactedServerEnvironment(
  config: ServerEnvironment,
): RedactedServerEnvironment {
  return {
    nodeEnv: config.nodeEnv,
    isProduction: config.isProduction,
    host: config.host,
    port: config.port,
    corsOrigins: config.corsOrigins,
    providerKeys: {
      anthropic: redact(config.providerKeys.anthropic),
      openai: redact(config.providerKeys.openai),
      deepseek: redact(config.providerKeys.deepseek),
    },
  };
}

function parseNodeEnv(value: string | undefined): NodeEnvironment {
  const normalized = readNonEmpty(value) ?? 'development';
  if (
    normalized === 'development' ||
    normalized === 'production' ||
    normalized === 'test'
  ) {
    return normalized;
  }
  throw new Error('NODE_ENV must be development, production, or test');
}

function parsePort(value: string | undefined): number {
  const normalized = readNonEmpty(value);
  if (!normalized) {
    return 3001;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseCorsOrigins(
  value: string | undefined,
  isProduction: boolean,
): string[] {
  const normalized = readNonEmpty(value);
  if (!normalized) {
    if (isProduction) {
      throw new Error('CORS_ORIGIN is required when NODE_ENV=production');
    }
    return defaultCorsOrigins;
  }

  const origins = normalized
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGIN must include at least one origin');
  }

  for (const origin of origins) {
    assertHttpOrigin(origin);
  }

  return origins;
}

function assertHttpOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('CORS_ORIGIN entries must be absolute http(s) origins');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== origin ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('CORS_ORIGIN entries must be absolute http(s) origins');
  }
}

function readNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function redact(value: string | undefined): '[set]' | '[unset]' {
  return value ? '[set]' : '[unset]';
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @colorful-code/server test`

预期：server test 命令 exit 0，新增环境测试和既有 e2e 都通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/server/src/config/environment.ts apps/server/test/environment.test.ts
git commit -m "feat(server): add environment configuration helper"
```

## 任务 2：接入 server 启动和 CORS

**文件：**

- 修改：`apps/server/src/main.ts`

- [ ] **步骤 1：编写失败的 e2e 测试**

扩展 `apps/server/test/environment.test.ts`，加入 `loadDevelopmentEnvFileIfPresent` 的行为测试：

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDevelopmentEnvFileIfPresent,
  loadServerEnvironment,
  toRedactedServerEnvironment,
} from '../src/config/environment';
```

并新增：

```ts
test('loadDevelopmentEnvFileIfPresent loads .env outside production', () => {
  const dir = mkdtempSync(join(tmpdir(), 'colorful-code-env-'));
  const previousPort = process.env.PORT;
  try {
    writeFileSync(join(dir, '.env'), 'PORT=3901\n');
    delete process.env.PORT;
    loadDevelopmentEnvFileIfPresent(dir, { NODE_ENV: 'development' });
    assert.equal(process.env.PORT, '3901');
  } finally {
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
```

如果需要保持 import 干净，把原来的 import 合并成一组。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @colorful-code/server test`

预期：当前实现若未调用 `loadEnvFile` 或函数未导出，会失败；若任务 1 已按计划实现，测试应通过。此步骤用于锁住 `.env` 加载行为，若直接通过，记录为已有 helper 已覆盖行为。

- [ ] **步骤 3：编写最少实现代码**

修改 `apps/server/src/main.ts`：

```ts
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import {
  loadDevelopmentEnvFileIfPresent,
  loadServerEnvironment,
} from './config/environment';

async function bootstrap() {
  loadDevelopmentEnvFileIfPresent();
  const serverEnvironment = loadServerEnvironment();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  await app.enableCors({
    origin: serverEnvironment.corsOrigins,
  });

  await app.listen(serverEnvironment.port, serverEnvironment.host);
}

void bootstrap();
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @colorful-code/server test`

预期：exit 0。

- [ ] **步骤 5：Commit**

```bash
git add apps/server/src/main.ts apps/server/test/environment.test.ts
git commit -m "feat(server): wire runtime environment into startup"
```

## 任务 3：脚本、Turbo env、example env 和文档

**文件：**

- 修改：`package.json`
- 修改：`apps/server/package.json`
- 修改：`apps/web/package.json`
- 修改：`turbo.json`
- 修改：`.gitignore`
- 创建：`.env.example`
- 创建：`apps/server/.env.example`
- 创建：`apps/web/.env.example`
- 创建：`README.md`

- [ ] **步骤 1：写入配置文件和脚本**

`package.json` scripts 增加：

```json
"start:prod": "turbo run start:prod"
```

`apps/server/package.json` scripts 增加：

```json
"start:prod": "node dist/main.js"
```

保留既有 `"start": "node dist/main.js"`。

`apps/web/package.json` scripts 增加：

```json
"start:prod": "next start"
```

`turbo.json` 增加顶层：

```json
"globalEnv": ["NODE_ENV"],
```

并在 `tasks` 中声明：

```json
"build": {
  "dependsOn": ["^build"],
  "outputs": ["dist/**", ".next/**"]
},
"dev": {
  "cache": false,
  "persistent": true,
  "passThroughEnv": [
    "HOST",
    "PORT",
    "CORS_ORIGIN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NEXT_PUBLIC_API_BASE_URL"
  ]
},
"start:prod": {
  "cache": false,
  "persistent": true,
  "dependsOn": ["build"],
  "passThroughEnv": [
    "HOST",
    "PORT",
    "CORS_ORIGIN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NEXT_PUBLIC_API_BASE_URL"
  ]
}
```

and add web build-specific env:

```json
"build": {
  "dependsOn": ["^build"],
  "outputs": ["dist/**", ".next/**"],
  "env": ["NEXT_PUBLIC_API_BASE_URL"]
}
```

`.gitignore` 增加：

```gitignore
.env
.env.local
.env.*.local
apps/*/.env
apps/*/.env.local
apps/*/.env.*.local
```

创建 `.env.example`：

```dotenv
NODE_ENV=development
```

创建 `apps/server/.env.example`：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3001
CORS_ORIGIN=http://localhost:3000
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
```

创建 `apps/web/.env.example`：

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

创建 `README.md`，包含：

````md
# Colorful Code

## Environments

`NODE_ENV` selects the runtime mode: `development`, `test`, or `production`.
Development defaults are convenient; production must provide explicit CORS origins.

Copy example files before local development:

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
```
````

Server variables:

- `HOST`: server bind host, default `127.0.0.1`
- `PORT`: server port, default `3001`
- `CORS_ORIGIN`: comma-separated browser origins allowed to call the server; required in production
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`: server-only provider secrets

Web variables:

- `NEXT_PUBLIC_API_BASE_URL`: public API base URL baked into the Next.js browser bundle at build time

Provider API keys must never use the `NEXT_PUBLIC_` prefix. Next.js exposes those values
to browser code.

## Commands

```bash
pnpm dev
pnpm build
pnpm start:prod
pnpm lint
pnpm typecheck
```

Build the web app separately per environment because `NEXT_PUBLIC_API_BASE_URL` is baked
into the generated bundle.

````

- [ ] **步骤 2：运行格式化检查**

运行：`pnpm format`

预期：如果失败，运行 `pnpm format:write` 修正格式，然后重跑 `pnpm format`。

- [ ] **步骤 3：运行验证**

运行：

```bash
pnpm --filter @colorful-code/server test
pnpm lint
pnpm typecheck
pnpm build
````

预期：全部 exit 0。

- [ ] **步骤 4：Commit**

```bash
git add package.json apps/server/package.json apps/web/package.json turbo.json .gitignore .env.example apps/server/.env.example apps/web/.env.example README.md
git commit -m "chore: separate development and production environments"
```

## 自检

- 规格覆盖度：`NODE_ENV`、server defaults、production CORS fail-fast、provider secrets、Next build-time var、Turbo env declaration、scripts、env examples、docs、tests 都有对应任务。
- 占位符扫描：计划没有未完成标记、悬空实现步骤或“类似任务”。
- 类型一致性：`ServerEnvironment`、`RedactedServerEnvironment`、`ProviderKeys`、`loadServerEnvironment`、`toRedactedServerEnvironment`、`loadDevelopmentEnvFileIfPresent` 在任务 1、2 中命名一致。
