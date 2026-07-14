# 工程文档导航

这里是 Colorful Code 工程设计与实施状态的统一入口。活跃目录只保留仍然有效或尚未完成的文档；已经实现并有代码、测试或提交证据的历史文档统一放入 `completed/`。

## 当前进度

| 阶段                          | 状态   | 说明                                                                                                   |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 1.x 产品与工程基础            | 已完成 | Agent、工具运行时、前后端、插件、语音、历史与发布能力已经落地                                          |
| Phase -1：安全冻结            | 已完成 | 1.x 安全修复、基线、备份与 2.0 边界已经验收                                                            |
| Phase 0A：Persistence Kernel  | 已完成 | 锁、迁移、备份恢复、Provider、Transaction、Clock、SQLite 策略、测试工厂和 1.x Schema 基线已经通过 Gate |
| Phase 0B：Contract Foundation | 下一步 | 建立 Contract Enums、Schema Authoring Foundation 和生成产物漂移检查                                    |
| Phase 0C–0E                   | 未开始 | Recovery Primitives、Thread Actor/EventMux、Ownership Foundation                                       |

完整的完成项、历史设计和实现证据见 [已完成工作归档](./completed/README.md)。

## 活跃计划

- [Colorful Code 2.0 Implementation Roadmap](./plans/2026-07-10-colorful-code-2-implementation-roadmap.md)

## 活跃规范

- [Core Architecture](./specs/2026-07-10-colorful-code-2-core-architecture-design.md)
- [Persistence Foundation](./specs/2026-07-10-colorful-code-2-persistence-foundation-design.md)
- [Thread Contract](./specs/2026-07-10-colorful-code-2-thread-contract-design.md)
- [Runtime Ownership and Recovery](./specs/2026-07-10-colorful-code-2-runtime-ownership-recovery-design.md)

这些规范是 Colorful Code 2.0 的长期约束，部分基础设施虽已在 Phase 0A 落地，但规范覆盖的 2.0 业务能力尚未全部实现，因此不能归档。

## 长期指南

- [Agent API](./guides/2026-07-01-agent-api.md)
- [Dogfood Testing Guide](./guides/dogfood-testing-guide.md)
- [Verification Matrix](./guides/verification-matrix.md)

## 目录规则

- `plans/`：只放仍在执行或尚未开始的计划。
- `specs/`：只放仍有效且尚未完全实现的规范。
- `completed/`：保存已经实现的历史设计、计划和完成证据；历史正文不因归档而重写。
- `guides/`：保存持续使用的操作与验证指南，不按开发阶段归档。
