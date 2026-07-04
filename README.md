# Colorful Code
感谢 zread 对本项目的文档支持
[![zread](https://img.shields.io/badge/Ask_Zread-_.svg?style=flat-square&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff)](https://zread.ai/lliooly/colorful-code)

Colorful Code 是一个面向本地开发场景的编码 Agent 工作台。项目提供 Web UI、NestJS Agent Server、Tauri 桌面壳和可复用的工具运行时，用来承载会话流、权限审批、文件与命令工具、MCP / LSP 插件、项目历史和检查点恢复等能力。

这个仓库是一个 pnpm monorepo，日常 TypeScript 任务由 Turborepo 编排；Bazel 作为未来多语言构建与桌面打包的预留层。

## 主要能力

- **Agent 会话：** 基于 SSE 流式输出消息、思考片段、工具调用、工具结果、审批请求和运行状态。
- **本地工作区：** 支持导入本地目录，将聊天绑定到项目路径，并在会话创建时传入 `cwd` 与 `workspaceRoots`。
- **权限控制：** 支持 `default`、`plan`、`acceptEdits`、`readOnly`、`bypass` 等模式；文件写入、命令执行和 MCP 工具会进入统一审批策略。
- **工具运行时：** 内置文件读写、编辑提案、Shell、搜索、任务、网络、Notebook、MCP 和 LSP 工具。
- **模型配置：** 内置 Claude、DeepSeek、OpenAI 和 Custom 预设，支持在 UI 中测试连接、拉取远端模型列表，并避免把 API key 持久化到会话快照。
- **插件管理：** 支持浏览 MCP Registry，安装 / 启用 / 禁用 / 删除 MCP、Skill、LSP 插件记录；启用的 MCP 与 LSP 会合并进新建或恢复的会话。
- **历史与检查点：** 区分 Projects 与 standalone Chats，支持 pin、删除、清空历史、恢复检查点和从检查点 fork。
- **桌面端：** Tauri 2 壳加载 `/agent` UI，提供原生目录 / 文件选择，并在需要时启动本地 Agent Server。
- **语音输入：** Web 端支持服务端语音转写接口；桌面端在 macOS 上提供系统语音事件桥接。

## 技术栈

- **包管理与任务编排：** pnpm 11、Turborepo
- **Web：** Next.js 16、React 19、Tailwind CSS、shadcn 风格组件
- **Server：** NestJS 11、Fastify、Bun、SQLite 持久化
- **Desktop：** Tauri 2、Rust
- **Runtime：** TypeScript 工具运行时、MCP SDK、LSP JSON-RPC
- **共享包：** workspace packages 承载 UI、schema、prompts、shared utilities 和通用配置

## 目录结构

```text
colorful-code/
├─ apps/
│  ├─ web/          # Next.js Agent UI，主页面在 /agent
│  ├─ server/       # NestJS + Fastify Agent Server
│  ├─ desktop/      # Tauri 2 桌面壳
│  └─ cli/          # 轻量命令行入口，直接调用 Session API
├─ packages/
│  ├─ tool-runtime/ # 工具、权限、MCP、LSP、会话引擎
│  ├─ ui/           # 共享 UI 基础组件与样式
│  ├─ schema/       # 跨端契约与 schema
│  ├─ prompts/      # 系统提示词、工具说明、工作流提示
│  └─ shared/       # 框架无关的共享工具
├─ tooling/         # TypeScript、ESLint、Prettier 共享配置
├─ docs/            # 设计文档、计划与指南
└─ bazel/           # Bazel bootstrap 说明
```

## 环境要求

- Node.js（需兼容 Next.js 16）
- pnpm `11.0.8`
- Bun（Server 与 CLI 当前依赖 Bun 运行）
- ripgrep (`rg`)（搜索工具运行时需要）
- Rust 与系统 Tauri 依赖（仅桌面端开发 / 打包需要）

## 快速开始

安装依赖：

```bash
pnpm install
```

复制环境变量模板：

```bash
cp .env.example .env
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
```

按需填写 `apps/server/.env` 中的模型服务密钥：

```bash
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
```

启动 Web UI 和 Agent Server：

```bash
pnpm dev
```

默认地址：

- Web UI: `http://localhost:3000/agent`
- Agent Server: `http://127.0.0.1:3367`

## 桌面端

开发模式：

```bash
pnpm --filter @colorful-code/desktop dev
```

打包：

```bash
pnpm --filter @colorful-code/desktop build
```

桌面端会加载 `apps/web` 的 `/agent` 页面，并确保 `http://127.0.0.1:3367` 上有可用的本地 Agent Server。如果没有检测到服务，它会从仓库根目录启动：

```bash
bun apps/server/src/main.ts
```

可用环境变量：

- `COLORFUL_CODE_REPO_ROOT`：无法自动推断仓库根目录时手动指定。
- `COLORFUL_CODE_SERVER_COMMAND`：覆盖用于启动 Server 的可执行命令，默认是 `bun`。

## CLI

根目录提供一个轻量 CLI 脚本，适合直接从终端创建会话并观察流式事件。使用前请先启动 Agent Server。

```bash
pnpm agent:cli --cwd "$PWD" --prompt "帮我总结这个项目"
```

常用参数：

- `--api-base <url>`：Server 地址，默认 `http://127.0.0.1:3367`。
- `--api-key <key>`：自带模型服务密钥，会走 Custom 模型配置。
- `--protocol <name>`：`anthropic` 或 `openai`。
- `--model <id>`：模型 ID。
- `--base-url <url>`：OpenAI-compatible 或自定义服务地址。
- `--preset <id>`：使用 Server 侧预设。
- `--mcp-config <path>`：加载包含 `mcpServers` 的 JSON 配置。

## 环境变量

根目录 `.env`：

| 变量       | 说明                                              |
| ---------- | ------------------------------------------------- |
| `NODE_ENV` | 运行模式：`development`、`test` 或 `production`。 |

Server (`apps/server/.env`)：

| 变量                | 默认值                    | 说明                                                                  |
| ------------------- | ------------------------- | --------------------------------------------------------------------- |
| `HOST`              | `127.0.0.1`               | Server 监听地址。                                                     |
| `PORT`              | `3367`                    | Server 监听端口。                                                     |
| `CORS_ORIGIN`       | `http://localhost:3000`   | 允许访问 Server 的浏览器来源；生产环境必填，可用逗号分隔多个 origin。 |
| `DATABASE_PATH`     | `./data/colorful-code.db` | SQLite 持久化文件路径；测试可用 `:memory:`。                          |
| `ANTHROPIC_API_KEY` | 空                        | Claude 预设使用的服务端密钥。                                         |
| `OPENAI_API_KEY`    | 空                        | OpenAI 预设使用的服务端密钥。                                         |
| `DEEPSEEK_API_KEY`  | 空                        | DeepSeek 预设使用的服务端密钥。                                       |

Web (`apps/web/.env.local`)：

| 变量                       | 默认值                  | 说明                                                              |
| -------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://127.0.0.1:3367` | 浏览器访问 Agent Server 的基础地址；构建时会写入 Next.js bundle。 |

注意：服务商 API key 必须只放在 Server 环境变量或一次性请求体里，不要使用 `NEXT_PUBLIC_` 前缀。Next.js 会把 `NEXT_PUBLIC_*` 暴露给浏览器代码。

## 常用命令

```bash
pnpm dev          # 并行启动各应用开发任务
pnpm build        # 构建整个 workspace
pnpm start:prod   # 构建后以生产模式启动
pnpm lint         # 运行 lint
pnpm typecheck    # 运行类型检查
pnpm format       # 检查格式
pnpm format:write # 写入格式化结果
pnpm clean        # 清理构建产物
pnpm agent:cli    # 运行 CLI 入口
```

常用分包命令：

```bash
pnpm --filter @colorful-code/web dev
pnpm --filter @colorful-code/server dev
pnpm --filter @colorful-code/tool-runtime test
pnpm --filter @colorful-code/server test
pnpm --filter @colorful-code/desktop dev
```

## API 概览

主要 HTTP 边界：

- `GET /models/presets`：列出模型预设。
- `POST /models/test`：测试当前模型配置。
- `POST /models/list`：拉取 OpenAI-compatible 远端模型列表。
- `GET /projects`、`POST /projects`、`DELETE /projects/:id`：管理导入的本地项目。
- `POST /sessions`：创建项目会话或 standalone chat。
- `GET /sessions`：按 Projects / Chats 分组返回历史。
- `POST /sessions/:id/messages`：提交用户消息。
- `POST /sessions/:id/control`：发送审批、取消、压缩、权限模式切换等控制消息。
- `GET /sessions/:id/events`：订阅会话 SSE 事件。
- `GET /sessions/:id/checkpoints`：列出检查点。
- `POST /sessions/:id/checkpoints/:checkpointId/restore`：恢复检查点。
- `POST /sessions/:id/checkpoints/:checkpointId/fork`：从检查点 fork 新会话。
- `GET /plugins/registry/mcp`、`GET /plugins/registry/skills`、`GET /plugins/registry/lsp`：浏览插件目录。
- `GET /plugins/installed`、`POST /plugins/install`、`PATCH /plugins/installed/:id`、`DELETE /plugins/installed/:id`：管理已安装插件。

## 开发约定

- 共享契约优先放在 `packages/schema`，不要让前端和后端各写一份。
- Agent 工具、权限、MCP / LSP 适配和会话引擎放在 `packages/tool-runtime`。
- 可复用 UI 放在 `packages/ui`；应用级页面与状态留在 `apps/web`。
- Server API 输入目前以手写校验为主，避免把未校验 JSON 直接传入运行时。
- Web 构建会固化 `NEXT_PUBLIC_API_BASE_URL`，不同环境需要分别构建。
- `apps/server/data/` 里的 SQLite 文件属于本地开发状态，不应提交。

## 设计文档

更多背景可以从这些文档开始：

- [Agent Monorepo Design](./docs/superpowers/specs/2026-06-27-agent-monorepo-design.md)
- [Agent Backend Spine](./docs/superpowers/specs/2026-06-29-agent-backend-spine-design.md)
- [Projects and Chat History](./docs/superpowers/specs/2026-07-03-projects-and-chat-history-design.md)
- [MCP Plugin Registry](./docs/superpowers/specs/2026-07-03-mcp-plugin-registry-design.md)
- [Unified Plugin Catalog](./docs/superpowers/specs/2026-07-03-unified-plugin-catalog-design.md)