# Tool Runtime Clean-Room Design

## Overview

This spec defines a clean-room tool runtime for Colorful Code. It borrows architectural ideas from mature coding agents without copying leaked implementation code: tools are declarative objects, the registry owns lookup, the runner owns validation and permission flow, and the scheduler owns concurrency and cancellation.

## Goals

- Add a reusable `@colorful-code/tool-runtime` package.
- Keep the first runtime framework-agnostic and usable from the future Nest server, desktop app, or tests.
- Implement a minimal built-in tool set: `Read`, `Write`, `Edit`, `Bash`, `Glob`, and `Grep`.
- Preserve critical safety behavior: schema validation, read-before-edit, stale edit protection, permission denial, and conservative scheduling.
- Use Node built-in test tooling so the package does not require new test dependencies.

## Non-Goals

- No UI rendering layer.
- No MCP integration in this first package.
- No sandbox implementation beyond permission and timeout hooks.
- No copying source code, prompts, telemetry structures, or UI copy from any leaked repository.

## Architecture

The package is split into focused units:

- `core/tool.ts`: `Tool` interface and `buildTool` helper with safe defaults.
- `core/registry.ts`: registration, name lookup, alias lookup, and duplicate protection.
- `core/runner.ts`: turns a model-style `tool_use` into a `tool_result` by validating input, running tool-specific validation, resolving permissions, invoking the tool, and mapping output.
- `core/scheduler.ts`: batches concurrency-safe tool uses together and runs mutating tools serially.
- `tools/files.ts`: `Read`, `Write`, and `Edit` with read state and stale checks.
- `tools/bash.ts`: minimal shell execution with timeout and abort support.
- `tools/search.ts`: small filesystem glob and grep tools.

## Data Flow

A caller builds a registry from built-in tools, creates a `ToolRunner`, and passes model tool uses into `ToolScheduler.runAll()`. The scheduler decides whether neighboring calls can run concurrently. Each call then flows through the runner:

1. Find the tool by name or alias.
2. Parse input with the tool schema.
3. Run `validateInput`.
4. Run `checkPermissions` or the caller-provided permission policy.
5. Invoke `tool.call`.
6. Map output into a stable `ToolResultBlock`.

## Safety Rules

- Defaults fail conservatively: tools are not concurrency-safe and not read-only unless they say so.
- `Edit` requires a prior complete `Read` of the same file.
- `Edit` re-checks file modification time and content before writing.
- Permission denial returns an error result without calling the tool.
- Scheduler runs mutating tools one at a time.

## Verification

Tests must cover the contract before implementation: default tool behavior, registry lookup, permission denial, runner result mapping, concurrency-safe scheduling, serial mutating scheduling, read-before-edit, and stale edit rejection.
