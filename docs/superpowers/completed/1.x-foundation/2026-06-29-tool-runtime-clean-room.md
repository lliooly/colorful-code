# Tool Runtime Clean-Room 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `packages/tool-runtime` 中构建一个 clean-room 工具运行时，复刻成熟 coding agent 的分层思想而不复制实现代码。

**架构：** `Tool` 对象声明能力，`ToolRegistry` 管查找，`ToolRunner` 管校验、权限和调用，`ToolScheduler` 管并发和串行。内置工具先覆盖本地文件、Shell、搜索三类能力。

**技术栈：** TypeScript、Node.js built-in `node:test`、pnpm workspace、Turborepo

---

## Planned File Structure

- 创建：`packages/tool-runtime/package.json`：包元信息和 build/typecheck/test/lint/clean 脚本。
- 创建：`packages/tool-runtime/tsconfig.json`：生产编译配置。
- 创建：`packages/tool-runtime/tsconfig.test.json`：测试编译配置。
- 创建：`packages/tool-runtime/src/index.ts`：公共 API 出口。
- 创建：`packages/tool-runtime/src/core/schema.ts`：最小 schema parser helpers。
- 创建：`packages/tool-runtime/src/core/tool.ts`：Tool 类型和 buildTool。
- 创建：`packages/tool-runtime/src/core/registry.ts`：ToolRegistry。
- 创建：`packages/tool-runtime/src/core/runner.ts`：ToolRunner。
- 创建：`packages/tool-runtime/src/core/scheduler.ts`：ToolScheduler。
- 创建：`packages/tool-runtime/src/tools/files.ts`：Read/Write/Edit。
- 创建：`packages/tool-runtime/src/tools/bash.ts`：Bash。
- 创建：`packages/tool-runtime/src/tools/search.ts`：Glob/Grep。
- 创建：`packages/tool-runtime/src/__tests__/core.test.ts`：核心运行时行为测试。
- 创建：`packages/tool-runtime/src/__tests__/scheduler.test.ts`：调度行为测试。
- 创建：`packages/tool-runtime/src/__tests__/file-tools.test.ts`：文件工具安全行为测试。
- 修改：`tsconfig.base.json`：加入 `@colorful-code/tool-runtime` 路径别名。
- 修改：`tsconfig.json`：加入 package project reference。

## Tasks

- [ ] Red: write tests and verify the package fails because runtime exports do not exist.
- [ ] Green core: implement schema helpers, Tool, registry, and runner.
- [ ] Green scheduler: implement concurrency batching and serial mutation behavior.
- [ ] Green built-ins: implement Read/Write/Edit/Bash/Glob/Grep.
- [ ] Integrate with workspace TS paths and verify test/typecheck/build.
