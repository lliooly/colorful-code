# Agent Monorepo Bootstrap Implementation Plan

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 搭建一个以 `pnpm + Turborepo` 为主、预留 `Bazel + Tauri 2` 扩展位的 Agent 课程项目 monorepo 骨架，并保证本地与 CI 能完成基础校验。

**架构：** 根目录负责工作区编排、统一脚本、CI 和 Bazel 入口；`apps/web` 与 `apps/server` 提供最小前后端壳；`packages/*` 承载共享 UI、schema、prompts 与通用工具；`tooling/*` 集中管理工程配置。第一阶段不实现业务功能，只确保边界清晰、可安装、可构建、可继续演进。

**技术栈：** TypeScript、pnpm workspaces、Turborepo、Next.js、React、NestJS、Fastify、Zod、Bazel、GitHub Actions、shadcn/ui

---

## Planned File Structure

### Root Workspace

- 创建：`/Users/shishishi/Desktop/colorful-code/package.json`
  - 根工作区元信息、统一脚本、`packageManager`、基础开发依赖
- 创建：`/Users/shishishi/Desktop/colorful-code/pnpm-workspace.yaml`
  - 声明 `apps/*`、`packages/*`、`tooling/*`
- 创建：`/Users/shishishi/Desktop/colorful-code/turbo.json`
  - 定义 `build`、`lint`、`typecheck`、`dev`、`clean`
- 创建：`/Users/shishishi/Desktop/colorful-code/tsconfig.base.json`
  - 工作区共享 TS 基础配置
- 创建：`/Users/shishishi/Desktop/colorful-code/tsconfig.json`
  - 根 TS 工程引用入口
- 创建：`/Users/shishishi/Desktop/colorful-code/.gitignore`
  - 忽略 Node、Next、Nest、Bazel、系统产物
- 创建：`/Users/shishishi/Desktop/colorful-code/.npmrc`
  - `pnpm` workspace 基础行为

### Tooling Packages

- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/base.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/nextjs.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/nestjs.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/package-library.json`
  - 统一 TS 配置分层
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/base.js`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/next.js`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/nest.js`
  - 统一 ESLint 配置出口
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/prettier-config/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/prettier-config/index.js`
  - 统一 Prettier 配置

### Applications

- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/next.config.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/eslint.config.mjs`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/app/layout.tsx`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/app/page.tsx`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/app/globals.css`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/postcss.config.mjs`
  - Next.js 最小可运行壳，先能消费 `@colorful-code/ui`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/tsconfig.build.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/eslint.config.mjs`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/nest-cli.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/main.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/app.module.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/app.controller.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/app.service.ts`
  - NestJS + Fastify 最小可构建壳
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/desktop/README.md`
  - 记录未来 Tauri 2 集成边界，不在本期实现 Rust 工程

### Shared Packages

- 创建：`/Users/shishishi/Desktop/colorful-code/packages/shared/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/shared/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/shared/src/index.ts`
  - 通用常量与类型出口
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/schema/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/schema/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/schema/src/index.ts`
  - Zod 契约出口
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/prompts/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/prompts/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/prompts/src/index.ts`
  - Prompt 模板出口
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/src/index.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/src/lib/utils.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/src/styles.css`
- 修改或生成：`/Users/shishishi/Desktop/colorful-code/components.json`
  - 承载 shadcn/ui 自定义风格组件入口

### Bazel and CI

- 创建：`/Users/shishishi/Desktop/colorful-code/MODULE.bazel`
- 创建：`/Users/shishishi/Desktop/colorful-code/.bazelrc`
- 创建：`/Users/shishishi/Desktop/colorful-code/bazel/README.md`
  - 第一阶段仅建立 Bazel-ready 根
- 创建：`/Users/shishishi/Desktop/colorful-code/.github/workflows/ci.yml`
  - `push` / `pull_request` 基础校验

## 任务 1：根工作区骨架与统一脚本

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/pnpm-workspace.yaml`
- 创建：`/Users/shishishi/Desktop/colorful-code/turbo.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tsconfig.base.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/.gitignore`
- 创建：`/Users/shishishi/Desktop/colorful-code/.npmrc`

- [ ] **步骤 1：创建根 `package.json`**

```json
{
  "name": "colorful-code",
  "private": true,
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "format": "prettier --check .",
    "format:write": "prettier --write .",
    "clean": "turbo clean"
  },
  "devDependencies": {
    "prettier": "^3.5.0",
    "turbo": "^2.0.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **步骤 2：创建工作区与 Turbo 配置**

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tooling/*"
```

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "lint": {},
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "clean": {
      "cache": false
    }
  }
}
```

- [ ] **步骤 3：创建根 TS、npm 与忽略文件**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "baseUrl": "."
  }
}
```

```json
{
  "files": [],
  "references": []
}
```

```text
# .npmrc
auto-install-peers=true
strict-peer-dependencies=false
```

```text
# .gitignore
node_modules
.turbo
.next
dist
coverage
.DS_Store
bazel-*
```

- [ ] **步骤 4：安装根依赖并生成锁文件**

运行：`pnpm install`

预期：生成 `pnpm-lock.yaml`，根工作区安装成功，无未解析 workspace 报错。

- [ ] **步骤 5：验证根命令可解析**

运行：`pnpm turbo run lint --dry-run`

预期：Turbo 能识别根任务图，即使尚无全部包任务，也不出现 JSON 或配置解析错误。

- [ ] **步骤 6：Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.json .gitignore .npmrc pnpm-lock.yaml
git commit -m "chore: add workspace root configuration"
```

## 任务 2：统一工程配置包

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/base.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/nextjs.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/nestjs.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/typescript-config/package-library.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/base.js`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/next.js`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/eslint-config/nest.js`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/prettier-config/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/tooling/prettier-config/index.js`

- [ ] **步骤 1：创建 TypeScript 配置包**

```json
{
  "name": "@colorful-code/typescript-config",
  "version": "0.0.0",
  "private": true,
  "files": ["*.json"]
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true
  }
}
```

```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "allowJs": false,
    "incremental": true,
    "plugins": [{ "name": "next" }]
  }
}
```

```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **步骤 2：创建 ESLint 配置包**

```json
{
  "name": "@colorful-code/eslint-config",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

```js
export default [
  {
    ignores: ["dist/**", ".next/**", "node_modules/**"]
  }
];
```

```js
import base from "./base.js";

export default [...base];
```

```js
import base from "./base.js";

export default [...base];
```

- [ ] **步骤 3：创建 Prettier 配置包**

```json
{
  "name": "@colorful-code/prettier-config",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

```js
export default {
  semi: true,
  singleQuote: true,
  trailingComma: "all"
};
```

- [ ] **步骤 4：安装配置包所需依赖**

运行：`pnpm add -Dw eslint @eslint/js typescript-eslint`

预期：根依赖更新成功，后续 app/package 可复用统一 lint 基座。

- [ ] **步骤 5：验证配置包可被工作区识别**

运行：`pnpm --filter @colorful-code/typescript-config exec node -e "console.log('ok')"`

预期：workspace filter 正常解析，无包名冲突。

- [ ] **步骤 6：Commit**

```bash
git add tooling package.json pnpm-lock.yaml
git commit -m "chore: add shared tooling packages"
```

## 任务 3：共享基础包

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/shared/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/shared/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/shared/src/index.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/schema/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/schema/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/schema/src/index.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/prompts/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/prompts/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/prompts/src/index.ts`

- [ ] **步骤 1：创建 `shared` 包**

```json
{
  "name": "@colorful-code/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

```json
{
  "extends": "@colorful-code/typescript-config/package-library.json"
}
```

```ts
export const WORKSPACE_NAME = 'colorful-code';

export type HealthStatus = 'ok';
```

- [ ] **步骤 2：创建 `schema` 包**

```json
{
  "name": "@colorful-code/schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "zod": "^3.25.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

```ts
import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
```

- [ ] **步骤 3：创建 `prompts` 包**

```json
{
  "name": "@colorful-code/prompts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

```ts
export const systemPrompt = `You are the colorful-code course project assistant.`;
```

- [ ] **步骤 4：安装共享包依赖并校验类型**

运行：`pnpm install`

预期：workspace 新包依赖写入锁文件，`zod` 安装成功。

- [ ] **步骤 5：验证共享包类型检查**

运行：`pnpm --filter @colorful-code/schema typecheck`

预期：PASS，无 TS 解析错误。

- [ ] **步骤 6：Commit**

```bash
git add packages package.json pnpm-lock.yaml
git commit -m "feat: add shared workspace packages"
```

## 任务 4：共享 UI 包与 shadcn/ui 风格接入

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/src/index.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/src/lib/utils.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/packages/ui/src/styles.css`
- 创建或修改：`/Users/shishishi/Desktop/colorful-code/components.json`

- [ ] **步骤 1：创建 `ui` 包最小壳**

```json
{
  "name": "@colorful-code/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

```ts
export * from './lib/utils';
```

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **步骤 2：安装 UI 包基础依赖**

运行：`pnpm add clsx tailwind-merge --filter @colorful-code/ui`

预期：`ui` 包能提供公共 className 工具。

- [ ] **步骤 3：运行 shadcn 初始化命令到 monorepo**

运行：`pnpm dlx shadcn@latest init --preset b1VlJFWE --template next --monorepo --rtl --pointer`

预期：生成 `components.json` 及相关 UI 样式资产；如果生成位置与 `packages/ui` 设计不一致，后续步骤需要手动整理到共享包边界。

- [ ] **步骤 4：整理 shadcn 产物到共享 UI 包**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "apps/web/app/globals.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@colorful-code/ui/src/components",
    "utils": "@colorful-code/ui/src/lib/utils"
  }
}
```

```ts
export * from './components/button';
export * from './lib/utils';
```

- [ ] **步骤 5：验证 `ui` 包类型与导出**

运行：`pnpm --filter @colorful-code/ui typecheck`

预期：PASS；若 shadcn 生成的组件带来额外 peer 依赖，则在此阶段补齐缺失依赖。

- [ ] **步骤 6：Commit**

```bash
git add packages/ui components.json apps/web/app/globals.css pnpm-lock.yaml
git commit -m "feat: add shared ui package scaffold"
```

## 任务 5：Next.js 前端壳

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/next.config.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/eslint.config.mjs`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/postcss.config.mjs`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/app/layout.tsx`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/web/app/page.tsx`
- 创建或修改：`/Users/shishishi/Desktop/colorful-code/apps/web/app/globals.css`

- [ ] **步骤 1：创建 `web` 包元信息**

```json
{
  "name": "@colorful-code/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint . --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@colorful-code/prompts": "workspace:*",
    "@colorful-code/schema": "workspace:*",
    "@colorful-code/shared": "workspace:*",
    "@colorful-code/ui": "workspace:*",
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

- [ ] **步骤 2：创建 Next.js 配置与 TS 配置**

```json
{
  "extends": "@colorful-code/typescript-config/nextjs.json",
  "compilerOptions": {
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]
}
```

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@colorful-code/ui'],
};

export default nextConfig;
```

- [ ] **步骤 3：创建最小页面壳**

```tsx
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

```tsx
import { WORKSPACE_NAME } from '@colorful-code/shared';

export default function HomePage() {
  return (
    <main>
      <h1>{WORKSPACE_NAME}</h1>
      <p>Agent monorepo scaffold is ready to grow.</p>
    </main>
  );
}
```

- [ ] **步骤 4：安装 Next.js 应用依赖**

运行：`pnpm install`

预期：`apps/web` 新依赖安装成功，workspace 包解析正常。

- [ ] **步骤 5：验证前端类型检查与构建**

运行：`pnpm --filter @colorful-code/web typecheck`

预期：PASS。

运行：`pnpm --filter @colorful-code/web build`

预期：PASS，Next.js 成功生成 `.next`。

- [ ] **步骤 6：Commit**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat: add web app scaffold"
```

## 任务 6：NestJS + Fastify 后端壳

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/package.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/tsconfig.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/tsconfig.build.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/eslint.config.mjs`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/nest-cli.json`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/main.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/app.module.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/app.controller.ts`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/server/src/app.service.ts`

- [ ] **步骤 1：创建 `server` 包元信息**

```json
{
  "name": "@colorful-code/server",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "lint": "eslint src --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@colorful-code/prompts": "workspace:*",
    "@colorful-code/schema": "workspace:*",
    "@colorful-code/shared": "workspace:*",
    "@fastify/cors": "^11.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-fastify": "^11.0.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0"
  }
}
```

- [ ] **步骤 2：创建 Nest 配置文件**

```json
{
  "extends": "@colorful-code/typescript-config/nestjs.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": false
  },
  "exclude": ["node_modules", "dist", "test", "**/*spec.ts"]
}
```

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

- [ ] **步骤 3：创建最小 Fastify 健康检查**

```ts
import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@colorful-code/schema';

@Controller()
export class AppController {
  @Get('health')
  health(): HealthResponse {
    return { status: 'ok' };
  }
}
```

```ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

@Module({
  controllers: [AppController],
})
export class AppModule {}
```

```ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  await app.listen(3001, '0.0.0.0');
}

void bootstrap();
```

- [ ] **步骤 4：安装后端依赖**

运行：`pnpm install`

预期：NestJS 与 Fastify 依赖安装成功。

- [ ] **步骤 5：验证后端类型检查与构建**

运行：`pnpm --filter @colorful-code/server typecheck`

预期：PASS。

运行：`pnpm --filter @colorful-code/server build`

预期：PASS，生成 `apps/server/dist`。

- [ ] **步骤 6：Commit**

```bash
git add apps/server package.json pnpm-lock.yaml
git commit -m "feat: add server app scaffold"
```

## 任务 7：Bazel 根入口与桌面预留位

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/MODULE.bazel`
- 创建：`/Users/shishishi/Desktop/colorful-code/.bazelrc`
- 创建：`/Users/shishishi/Desktop/colorful-code/bazel/README.md`
- 创建：`/Users/shishishi/Desktop/colorful-code/apps/desktop/README.md`

- [ ] **步骤 1：创建 Bazel 根模块**

```python
module(
    name = "colorful_code",
    version = "0.0.0",
)
```

```text
build --enable_bzlmod
common --announce_rc
```

- [ ] **步骤 2：记录 Bazel 角色说明**

```md
# Bazel Bootstrap

This repository uses pnpm and Turborepo for the first-phase TypeScript workflow.
Bazel is introduced early so future Rust, Tauri 2, and other multi-language targets
can be added without restructuring the repository.
```

- [ ] **步骤 3：创建桌面端预留说明**

```md
# Desktop App Placeholder

This directory is reserved for a future Tauri 2 application.

Planned responsibilities:
- package the frontend into an executable desktop shell
- host Rust-side integration code
- decide later whether to call the backend directly or bundle runtime artifacts
```

- [ ] **步骤 4：验证 Bazel 文件存在且格式正确**

运行：`test -f MODULE.bazel && test -f .bazelrc && test -f bazel/README.md`

预期：PASS，根 Bazel 文件齐全。

- [ ] **步骤 5：Commit**

```bash
git add MODULE.bazel .bazelrc bazel apps/desktop
git commit -m "chore: reserve bazel and desktop integration roots"
```

## 任务 8：CI 与全仓验证

**文件：**
- 创建：`/Users/shishishi/Desktop/colorful-code/.github/workflows/ci.yml`
- 修改：`/Users/shishishi/Desktop/colorful-code/package.json`

- [ ] **步骤 1：创建 GitHub Actions 工作流**

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
```

- [ ] **步骤 2：补全根格式化脚本到可写模式**

```json
{
  "scripts": {
    "format": "prettier --check .",
    "format:write": "prettier --write ."
  }
}
```

- [ ] **步骤 3：执行全仓验证**

运行：`pnpm lint`

预期：PASS。

运行：`pnpm typecheck`

预期：PASS。

运行：`pnpm build`

预期：PASS。

- [ ] **步骤 4：执行最终仓库状态检查**

运行：`git status --short`

预期：只剩本任务尚未提交的 CI 与必要配置更改。

- [ ] **步骤 5：Commit**

```bash
git add .github/workflows/ci.yml package.json pnpm-lock.yaml
git commit -m "ci: add workspace verification workflow"
```

## Self-Check

- 规格中的 `web`、`server`、`ui`、`shared`、`schema`、`prompts`、`tooling`、`CI`、`Bazel`、`desktop` 预留位均已映射到独立任务。
- 计划中没有 `TODO`、`待定`、`后续补充` 等占位符。
- `HealthResponse` 类型先在 `packages/schema` 定义，再在 `apps/server` 中消费，命名一致。
- `@colorful-code/*` 包名在所有任务中保持一致。
- 所有验证命令都指向本地可执行的 `pnpm` 或 shell 检查命令。
