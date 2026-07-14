# 已完成文档归档实现计划

> **面向 AI 代理的工作者：** 使用内联执行逐项完成本计划。步骤使用复选框（`- [ ]`）跟踪；本次只整理文档，不修改产品代码，不暂存或提交。

**目标：** 将已有代码、测试和提交证据支持的已完成 spec/plan 迁入统一归档，并为活跃工作和已完成工作建立清晰入口。

**架构：** `docs/superpowers/README.md` 作为总入口，只展示当前活跃阶段和归档入口；`docs/superpowers/completed/README.md` 记录完成项、阶段、实现证据和历史文档链接。历史原文按 `1.x-foundation`、`phase-minus-one`、`phase-0a` 和 `maintenance` 分类保存，不合并、不删减。

**技术栈：** Markdown、Git 文件历史、ripgrep、Prettier。

---

## 任务 1：冻结归档清单

**文件：**

- 审计：`docs/superpowers/plans/*.md`
- 审计：`docs/superpowers/specs/*.md`
- 创建：`docs/superpowers/completed/README.md`

- [x] 根据代码、测试和实现提交，把 1.x 已完成工作、Phase -1、Phase 0A 文档列入归档。
- [x] 保留 Colorful Code 2.0 Roadmap 和 4 份 Normative 总体规格在活跃目录。
- [x] 保留 `guides/` 原位，避免把长期操作手册误判为历史设计。

## 任务 2：迁移历史原文

**文件：**

- 创建：`docs/superpowers/completed/1.x-foundation/`
- 创建：`docs/superpowers/completed/phase-minus-one/`
- 创建：`docs/superpowers/completed/phase-0a/`
- 创建：`docs/superpowers/completed/maintenance/`
- 移动：审计确认完成的 27 份历史文档和本计划

- [x] 使用文件移动保留原文和 Git rename 历史，不重新合并 spec/plan。
- [x] 将本计划移入 `completed/maintenance/`，确保活跃 `plans/` 不残留已完成整理任务。

## 任务 3：建立统一导航

**文件：**

- 创建：`docs/superpowers/README.md`
- 创建：`docs/superpowers/completed/README.md`

- [x] 总入口明确显示当前进度：Phase -1、Phase 0A 已完成；下一阶段为 Phase 0B。
- [x] 完成索引按工作项列出状态、spec、plan 和实现证据；不存在的 spec 或 plan 使用 `—`，不伪造文档。
- [x] 活跃入口只链接 Roadmap、Core Architecture、Persistence Foundation、Thread Contract、Runtime Ownership and Recovery 与 guides。

## 任务 4：修复引用并验证

**文件：**

- 修改：所有仍引用旧 `plans/` 或 `specs/` 路径的 Markdown 文件

- [x] 搜索旧路径并改为新的相对路径。
- [x] 扫描所有 Markdown 本地链接，确认目标文件存在且不越出仓库。
- [x] 对新建导航、完成索引和归档计划运行 `pnpm exec prettier --check`；纯移动历史原文不批量重排。
- [x] 运行 `git diff --check`，确认暂存区为空，并核对活跃目录只剩未完成文档。
