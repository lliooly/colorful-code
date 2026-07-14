# 已完成工作归档

本目录收录已经有实际代码、测试或合并提交支持的历史设计与实施计划。归档表示对应工作已经实现，不表示历史文档中的复选框都曾被逐项回填；完成状态以本索引列出的实现证据和当前测试为准。

最后审计日期：2026-07-14。

## 1.x 产品与工程基础

| 已完成工作                                  | 设计                                                                    | 计划                                                              | 主要实现证据                                          |
| ------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Agent Monorepo Bootstrap                    | [设计](./1.x-foundation/2026-06-27-agent-monorepo-design.md)            | [计划](./1.x-foundation/2026-06-27-agent-monorepo-bootstrap.md)   | `5b790b4c`，根工作区 build/lint/typecheck             |
| Tool Runtime Clean-Room                     | [设计](./1.x-foundation/2026-06-29-tool-runtime-clean-room-design.md)   | [计划](./1.x-foundation/2026-06-29-tool-runtime-clean-room.md)    | `5781a25d`，`packages/tool-runtime` 测试              |
| Agent Backend Spine 与 Server Model Rollout | [设计](./1.x-foundation/2026-06-29-agent-backend-spine-design.md)       | [计划](./1.x-foundation/2026-06-29-agent-server-model-rollout.md) | `bf958243`、`f3a5c8dd`，Server E2E 测试               |
| Environment Split                           | [设计](./1.x-foundation/2026-06-29-environment-split-design.md)         | [计划](./1.x-foundation/2026-06-29-environment-split.md)          | `f905345d`，`environment.test.ts`                     |
| Agent Frontend                              | —                                                                       | [计划](./1.x-foundation/2026-07-01-agent-frontend.md)             | `c038bd24`、`1ce75e96`，Web Agent 测试                |
| MCP Plugin Registry                         | [设计](./1.x-foundation/2026-07-03-mcp-plugin-registry-design.md)       | [计划](./1.x-foundation/2026-07-03-mcp-plugin-registry.md)        | `e0d3923d`，Plugin CRUD 与 Session merge 测试         |
| Realtime Voice Input                        | —                                                                       | [计划](./1.x-foundation/2026-07-03-realtime-voice-input.md)       | `2195c494`，Voice service/API/recorder 测试           |
| Projects and Chat History                   | [设计](./1.x-foundation/2026-07-03-projects-and-chat-history-design.md) | —                                                                 | `c1ef200e`，Projects History E2E 测试                 |
| Unified Plugin Catalog                      | [设计](./1.x-foundation/2026-07-03-unified-plugin-catalog-design.md)    | [计划](./1.x-foundation/2026-07-03-unified-plugin-catalog.md)     | Skills/LSP/MCP catalog、安装与 Session merge 测试     |
| GitHub Release Automation                   | [设计](./1.x-foundation/2026-07-04-github-release-automation-design.md) | [计划](./1.x-foundation/2026-07-04-github-release-automation.md)  | `59efb177`、`v1.0.0`，`.github/workflows/release.yml` |

## Phase -1：1.x 安全冻结

| 已完成工作         | 设计                                                                         | 计划                                                                  | 主要实现证据                                     |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 1.x 安全冻结与基线 | [设计](./phase-minus-one/2026-07-10-phase-minus-one-safety-freeze-design.md) | [计划](./phase-minus-one/2026-07-10-phase-minus-one-safety-freeze.md) | `603e3dca`，凭据、权限、备份、基线与 V2 边界测试 |

## Phase 0A：Persistence Kernel

| 已完成工作                                            | 设计                                                                  | 计划                                                           | 主要实现证据                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Data-directory Instance Lock                          | —                                                                     | —                                                              | `f949c84b`，跨进程排他、身份校验与权限测试；原独立文档已按历史提交 `8184f7f7` 删除 |
| Migration Bootstrap Connection 与 Migration Framework | [设计](./phase-0a/2026-07-14-migration-bootstrap-framework-design.md) | [计划](./phase-0a/2026-07-14-migration-bootstrap-framework.md) | `ab05a0ed`，固定顺序、checksum、较新版本与 lifecycle 测试                          |
| Migration Backup 与 Recovery                          | [设计](./phase-0a/2026-07-14-migration-backup-recovery-design.md)     | [计划](./phase-0a/2026-07-14-migration-backup-recovery.md)     | `a77eac3a`，WAL、quarantine、atomic restore 与故障测试                             |
| DatabaseProvider、Transaction API 与 Database Clock   | [设计](./phase-0a/2026-07-14-database-kernel-design.md)               | [计划](./phase-0a/2026-07-14-database-kernel.md)               | `6fd064f7` 合并，Provider ownership、busy retry、同步 callback 与固定时间测试      |
| SQLite Configuration                                  | [设计](./phase-0a/2026-07-14-sqlite-test-foundation-design.md)        | [计划](./phase-0a/2026-07-14-sqlite-test-foundation.md)        | 统一 PRAGMA、WAL 回读、诊断、只读连接与 checkpoint 测试                            |
| Test Database Factory                                 | [设计](./phase-0a/2026-07-14-sqlite-test-foundation-design.md)        | [计划](./phase-0a/2026-07-14-sqlite-test-foundation.md)        | 隔离、固定 Clock、busy、failure、restart 与清理测试                                |
| 1.x Schema Baseline                                   | [设计](./phase-0a/2026-07-14-sqlite-test-foundation-design.md)        | [计划](./phase-0a/2026-07-14-sqlite-test-foundation.md)        | Schema manifest、version map、fixture checksum、异常历史数据与兼容测试             |
| Phase 0A 联合 Gate                                    | [Invariant 映射](../../../apps/server/test/phase-0a-invariants.json)  | [验收计划](./phase-0a/2026-07-14-sqlite-test-foundation.md)    | Server 388/388，完整 lint、typecheck、build 与独立安全/规格审查                    |

## 文档维护

- [已完成文档归档实现计划](./maintenance/2026-07-14-completed-document-archive.md)

## 下一步

Phase 0B 从 Contract Enums、Schema Authoring Foundation 和 Generated Artifact Drift Checks 开始。当前入口见 [工程文档导航](../README.md) 和 [2.0 Implementation Roadmap](../plans/2026-07-10-colorful-code-2-implementation-roadmap.md)。
