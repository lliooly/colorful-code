# Agent Monorepo Design

## Overview

This document defines the initial monorepo architecture for the course project Agent system. The goal of this phase is to establish a clean, extensible workspace foundation using TypeScript across the stack, while keeping the first delivery intentionally narrow: scaffold the repository structure, shared package boundaries, workspace tooling, a minimal Bazel entry layer for future multi-language builds, and a minimal CI pipeline.

The chosen stack is:

- Frontend: React, Next.js, Zustand, Monaco Editor, xterm.js
- Backend: NestJS, Fastify, Zod, Drizzle ORM, SQLite
- Desktop packaging target: Tauri 2 with Rust
- Language: TypeScript
- Workspace tooling: pnpm workspaces, Turborepo, Bazel

## Goals

- Create a monorepo that supports a Next.js frontend and NestJS backend.
- Predefine shared package boundaries that will support later Agent-specific work.
- Keep the first version limited to repository scaffolding rather than business features.
- Provide a simple CI workflow so each push or pull request verifies the workspace still builds cleanly.
- Reserve the repository shape required for a future Tauri 2 desktop application.
- Introduce Bazel early enough that later Rust and desktop packaging work does not require a repository-wide build migration.
- Make future additions such as shared schemas, prompt templates, editor integrations, and database support easy to add without restructuring the repository.

## Non-Goals

This phase does not include:

- Business logic implementation
- Agent orchestration or runtime behavior
- Monaco Editor or xterm.js integration
- Zustand store design
- Drizzle ORM or SQLite setup
- A working Tauri desktop application
- End-to-end tests
- Complex CI features such as multi-version matrices, deployment, or remote caching

## Chosen Architecture

The workspace will use `pnpm` for package management and workspaces, `Turborepo` for JavaScript and TypeScript task orchestration, and `Bazel` as the long-term multi-language build layer. This keeps the first phase simple for frontend and backend development while reserving a path for Rust and desktop packaging without forcing a disruptive later migration.

The first version will use a focused package layout:

```text
colorful-code/
├─ apps/
│  ├─ web/
│  ├─ server/
│  └─ desktop/            # reserved for a future Tauri 2 app, not fully implemented in this phase
├─ packages/
│  ├─ ui/
│  ├─ shared/
│  ├─ schema/
│  └─ prompts/
├─ tooling/
│  ├─ typescript-config/
│  ├─ eslint-config/
│  └─ prettier-config/
├─ docs/
│  └─ superpowers/
│     └─ specs/
├─ .github/
│  └─ workflows/
├─ bazel/
│  └─ README.md
├─ MODULE.bazel
├─ .bazelrc
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
└─ .gitignore
```

## Package Responsibilities

### Applications

- `apps/web`: the Next.js frontend application. It owns pages, app routing, local frontend composition, and later UI state integrations such as Zustand, Monaco Editor, and xterm.js.
- `apps/server`: the NestJS backend application using Fastify. It owns modules, controllers, services, and API composition.
- `apps/desktop`: reserved for a future Tauri 2 desktop shell. In this phase it exists only as a documented integration boundary so the workspace can evolve toward desktop packaging cleanly.

### Shared Packages

- `packages/ui`: shared UI primitives and styled components derived from the custom `shadcn/ui` preset. This package is the reusable visual layer consumed by the frontend app.
- `packages/shared`: framework-agnostic utilities, constants, and lightweight shared TypeScript types that do not belong in validation schemas.
- `packages/schema`: shared Zod schemas and cross-boundary contracts used by both frontend and backend. This package should remain independent from Next.js and NestJS.
- `packages/prompts`: prompt templates, prompt metadata, and reusable system or task prompt building blocks for later Agent features.

### Tooling Packages

- `tooling/typescript-config`: reusable base TypeScript configurations for apps and packages.
- `tooling/eslint-config`: reusable lint rules shared across the workspace.
- `tooling/prettier-config`: reusable formatting configuration shared across the workspace.

### Build System Layer

- `Turborepo`: the day-to-day task runner for the TypeScript workspace in the first phase.
- `Bazel`: the repository-level multi-language build system introduced early so future Rust and Tauri targets can be added without redesigning the monorepo.

## Naming Convention

All workspace packages should use a single scope:

- `@colorful-code/web`
- `@colorful-code/server`
- `@colorful-code/ui`
- `@colorful-code/shared`
- `@colorful-code/schema`
- `@colorful-code/prompts`
- `@colorful-code/typescript-config`
- `@colorful-code/eslint-config`
- `@colorful-code/prettier-config`

This keeps imports predictable and makes package ownership easy to understand.

## Version and Security Policy

During implementation, dependencies should default to current stable releases from actively maintained official packages. The team should prefer:

- official framework packages over community wrappers when possible
- current stable releases over outdated tutorials or abandoned examples
- packages with clear maintenance and security posture over convenient but risky alternatives

Exact versions should be verified at implementation time rather than frozen in this design document, because package ecosystems change frequently.

## Dependency Rules

The dependency graph should stay intentionally constrained:

- `apps/web` may depend on `ui`, `shared`, `schema`, and `prompts`.
- `apps/server` may depend on `shared`, `schema`, and `prompts`.
- `packages/ui` may depend on `shared`, but must not depend on `web`.
- `packages/schema` may depend on `zod` and pure TypeScript utilities only. It must not depend on frontend or backend frameworks.
- `packages/prompts` must stay independent from UI and NestJS-specific code.
- `packages/shared` should remain small and general-purpose rather than becoming an unbounded utilities bucket.

These rules preserve clear layering between applications, shared contracts, and implementation details.

## First-Phase Deliverables

The initial scaffold should produce the following:

- A root `pnpm` workspace with Turborepo configuration
- A minimal Next.js app in `apps/web`
- A minimal NestJS app in `apps/server`
- A reserved `apps/desktop` directory or placeholder documentation for future Tauri 2 integration
- Shared package shells for `ui`, `shared`, `schema`, and `prompts`
- Reusable configuration packages under `tooling/`
- Minimal Bazel root files that establish the repository as Bazel-ready without requiring full Bazel target coverage yet
- Root scripts for `dev`, `build`, `lint`, `typecheck`, `format`, and `clean`
- A basic GitHub Actions workflow for build verification

The first phase must stop at a usable workspace skeleton. It should not attempt to implement feature modules, database tables, editor panels, or terminal runtime behavior.

## Initialization Sequence

The repository setup should follow this order:

1. Initialize git and the root workspace metadata.
2. Create the monorepo directory structure for `apps`, `packages`, `tooling`, and `docs`.
3. Add root configuration files such as `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, and base TypeScript references.
4. Create the minimal application shells for Next.js and NestJS.
5. Create the package shells for `ui`, `shared`, `schema`, and `prompts`.
6. Add reusable workspace configuration packages under `tooling/`.
7. Add the initial Bazel root files and document how Bazel will later absorb multi-language targets.
8. Reserve the `apps/desktop` integration boundary for future Tauri 2 work.
9. Connect the custom `shadcn/ui` preset into `packages/ui`.
10. Add the minimal CI workflow and verify the workspace commands are wired consistently.

This order keeps the workspace bootstrappable from the root before adding package-specific details.

## Script Contract

The root workspace should expose these commands:

- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm format`
- `pnpm clean`

Bazel commands do not need to replace the root `pnpm` workflow in this phase. Bazel is being introduced as a repository capability and future integration path, not yet as the primary developer entrypoint.

Each application and shared package should expose a consistent subset of scripts where applicable:

- `dev`
- `build`
- `lint`
- `typecheck`

Applications may also expose `start` when that is part of their runtime contract.

This consistency matters because it allows Turborepo and CI to run the entire workspace without app-specific exceptions.

## Turborepo Pipeline

The first pipeline should remain minimal:

- `build` depends on upstream package `build` tasks
- `lint` runs independently
- `typecheck` runs across the workspace with upstream awareness
- `dev` is uncached and optimized for watch mode

Outputs should follow the native conventions of each tool, such as `.next` for Next.js and `dist` for build outputs.

The initial design intentionally avoids advanced pipeline features such as remote cache configuration or custom task matrices.

## Bazel Strategy

Bazel is introduced in this phase to reserve the repository for future multi-language builds, especially the addition of Rust-backed Tauri packaging. The first phase should keep Bazel intentionally light:

- include root Bazel configuration files
- document the expected role of Bazel in the repository
- avoid requiring full Bazel targets for every JavaScript package immediately
- keep `pnpm` and `Turborepo` as the main development workflow for the TypeScript applications

This gives the project a forward-compatible build foundation without making the first scaffold overly heavy.

## UI Strategy

The custom `shadcn/ui` preset is an important part of the project’s foundation, so the workspace should treat `packages/ui` as the source of truth for shared visual components. The frontend app should consume this package rather than embedding reusable UI primitives directly inside `apps/web`.

This keeps the design system portable and avoids coupling application routes to component ownership.

## Desktop Packaging Direction

The repository should explicitly reserve a path for future desktop packaging with Tauri 2. The intended direction is:

- build or export the frontend for desktop consumption
- let a Rust-backed Tauri shell package the application
- allow the desktop shell to either call the backend directly or later host packaged runtime artifacts depending on the final architecture choice

This phase does not need to decide that runtime integration in detail. It only needs to ensure the workspace layout does not block either path.

## CI Design

The repository should include a simple GitHub Actions workflow under `.github/workflows/ci.yml`.

It should run on:

- `push`
- `pull_request`

It should execute:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`

The CI workflow is intended only as a basic health check for the monorepo. It should not include database setup, end-to-end tests, deployment, or multi-version test matrices in this phase.

## Error Handling and Verification Expectations

The scaffold is considered correct when:

- Every workspace package is discoverable by `pnpm`
- Root scripts execute the intended Turborepo tasks
- The frontend and backend apps each build successfully in their minimal form
- Shared packages can be imported without circular dependency issues
- Bazel root configuration files are present and internally consistent
- CI runs the same lint, typecheck, and build commands used locally

Any setup issue found during implementation should be resolved by tightening workspace boundaries or configuration ownership rather than by introducing one-off exceptions.

## Testing Strategy for This Phase

This phase only requires infrastructure verification:

- Workspace install succeeds
- Lint succeeds
- Typecheck succeeds
- Build succeeds

Feature tests, database tests, and browser tests are deferred to later milestones when real product behavior exists.

## Recommended Implementation Shape

The implementation should favor a thin but clean scaffold:

- minimal app shells
- minimal package entrypoints
- shared config packages
- unified workspace scripts
- simple CI verification
- Bazel-ready repository roots
- reserved desktop integration boundary

The repository should feel ready for the next development step without pretending that core Agent features already exist.

## Decision Summary

- Use `pnpm workspaces` with `Turborepo`
- Introduce Bazel root configuration in the first phase as a future-facing multi-language layer
- Use `apps/web` and `apps/server` for the two runtime applications
- Reserve `apps/desktop` for future Tauri 2 integration without fully implementing it yet
- Use `packages/ui`, `shared`, `schema`, and `prompts` as the initial shared boundaries
- Use `tooling/*` for reusable engineering configuration
- Use a minimal GitHub Actions workflow for `push` and `pull_request`
- Keep the first phase focused on repository scaffolding only

## Next Step

After this specification is approved, the next task is to write an implementation plan that translates this architecture into concrete file creation, dependency setup, and verification steps.
