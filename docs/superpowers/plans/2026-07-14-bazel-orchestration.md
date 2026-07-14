# Bazel 统一构建入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为非桌面 workspace 与 Tauri/Rust 桌面端提供经过测试、可由 CI 使用的 Bazel 统一命令入口。

**架构：** 根 `sh_binary` targets 只把固定任务名交给一个严格 shell 适配器。适配器回到 `BUILD_WORKSPACE_DIRECTORY` 后 `exec` 现有 pnpm scripts，不引入锁、后台进程或额外并发层，也不声称提供 hermetic Bazel 构建。

**技术栈：** Bazel 9.1.0、Bash、pnpm、Turborepo、Bun、Cargo、GitHub Actions

---

## 文件结构

- 创建 `bazel/test/run-task.test.sh`：以临时 mock pnpm 验证命令映射、输入校验和退出状态。
- 创建 `bazel/run-task.sh`：固定 Bazel task 到现有 pnpm 命令的单向适配器。
- 创建 `BUILD.bazel`：声明七个根级 `sh_binary` 入口。
- 创建 `.bazelversion`：固定 Bazel 9.1.0。
- 修改 `.bazelrc`：让 run targets 继承受控环境变量并保持简洁输出。
- 修改 `.github/workflows/ci.yml`：安装 Bazelisk 并由 Bazel 入口驱动已有 CI 阶段。
- 修改 `bazel/README.md`：记录入口、依赖和非 hermetic 边界。
- 修改 `README.md`：补充开发者命令索引。

### 任务 1：以 TDD 实现严格任务适配器

**文件：**
- 创建：`bazel/test/run-task.test.sh`
- 创建：`bazel/run-task.sh`

- [ ] **步骤 1：编写失败测试**

测试脚本创建临时 `bin/pnpm`，把参数逐行写入 `PNPM_LOG`，再逐项调用尚不存在的 `bazel/run-task.sh`。精确断言以下映射：

```text
build           -> turbo run build --filter=!@colorful-code/desktop
lint            -> turbo run lint --filter=!@colorful-code/desktop
typecheck       -> turbo run typecheck --filter=!@colorful-code/desktop
test            -> run test
desktop-sidecar -> --filter @colorful-code/desktop build:server-sidecar
desktop-check   -> --filter @colorful-code/desktop lint
desktop-test    -> --filter @colorful-code/desktop test
```

测试还断言缺失 `BUILD_WORKSPACE_DIRECTORY`、缺失 pnpm、未知任务、多余参数和 mock pnpm 返回 23 时均失败，最后输出明确的通过计数。

- [ ] **步骤 2：验证红灯**

运行：`bash bazel/test/run-task.test.sh`  
预期：FAIL，原因是 `bazel/run-task.sh` 不存在。

- [ ] **步骤 3：实现最小适配器**

实现必须使用：

```bash
#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 ]] || { printf 'usage: %s <task>\n' "$0" >&2; exit 64; }
[[ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ]] || { printf 'BUILD_WORKSPACE_DIRECTORY is required\n' >&2; exit 64; }
command -v pnpm >/dev/null 2>&1 || { printf 'pnpm is required\n' >&2; exit 127; }
cd "$BUILD_WORKSPACE_DIRECTORY"

case "$1" in
  # 七个固定分支；每个分支以 exec pnpm ... 结束
  *) printf 'unknown task: %s\n' "$1" >&2; exit 64 ;;
esac
```

不得使用 `eval`、动态命令拼接、锁文件、后台任务或二次 shell。

- [ ] **步骤 4：验证绿灯和静态语法**

运行：`bash bazel/test/run-task.test.sh && bash -n bazel/run-task.sh bazel/test/run-task.test.sh`  
预期：测试全部 PASS，语法检查 exit 0。

- [ ] **步骤 5：提交**

```bash
git add bazel/run-task.sh bazel/test/run-task.test.sh
git commit -m "feat(构建): 添加 Bazel 任务适配器"
```

### 任务 2：声明并验证 Bazel 入口

**文件：**
- 创建：`BUILD.bazel`
- 创建：`.bazelversion`
- 修改：`.bazelrc`
- 测试：`bazel/test/run-task.test.sh`

- [ ] **步骤 1：先扩展失败测试**

为测试脚本增加声明检查：读取根 `BUILD.bazel`，用固定 label 列表验证七个目标均存在且都只引用 `//bazel:run-task` 或同一适配器；此时因文件不存在而失败。

- [ ] **步骤 2：验证红灯**

运行：`bash bazel/test/run-task.test.sh`  
预期：FAIL，原因是缺少根 `BUILD.bazel` 或目标声明。

- [ ] **步骤 3：增加 Bazel 配置**

在 `bazel/BUILD.bazel` 导出适配器，并在根 `BUILD.bazel` 用一个私有宏生成七个 `sh_binary`：

```starlark
def orchestration_target(name, task):
    sh_binary(
        name = name,
        srcs = ["//bazel:run-task.sh"],
        args = [task],
    )
```

`.bazelversion` 写入 `9.1.0`。`.bazelrc` 保留 Bzlmod，并通过 `run --action_env=NEXT_PUBLIC_API_BASE_URL` 允许 Next.js 构建读取显式环境值，不添加并发、锁或远程缓存配置。

- [ ] **步骤 4：验证绿灯与 Bazel 图**

运行：`bash bazel/test/run-task.test.sh`  
预期：全部 PASS。

若 Bazel 可用，运行：`bazel query '//:*'`  
预期：列出七个入口；再运行 `bazel run //:lint -- --help` 不合适，因为入口拒绝多余参数，所以实际冒烟测试为 `bazel run //:lint`。

- [ ] **步骤 5：提交**

```bash
git add BUILD.bazel bazel/BUILD.bazel bazel/test/run-task.test.sh .bazelversion .bazelrc
git commit -m "feat(构建): 暴露 Bazel workspace 入口"
```

### 任务 3：接入 CI 并完善文档

**文件：**
- 修改：`.github/workflows/ci.yml`
- 修改：`bazel/README.md`
- 修改：`README.md`

- [ ] **步骤 1：更新 CI**

两个 job 均在依赖安装后加入 `bazel-contrib/setup-bazel@v0.19.0`。quality job 依次运行 `bazel run //:lint`、`//:typecheck`、`//:build`、`//:test`；desktop job 依次运行 `//:desktop-sidecar`、`//:desktop-check`、`//:desktop-test`。保持现有 `NEXT_PUBLIC_API_BASE_URL` 只配置在 build step。

- [ ] **步骤 2：更新文档**

`bazel/README.md` 说明先安装依赖、目标矩阵、宿主工具要求、输出仍写入源码树、没有 remote cache/remote execution 保证。根 README 在现有命令区增加对应 Bazel 命令，不删除 pnpm 命令。

- [ ] **步骤 3：验证格式与配置**

运行：

```bash
bash bazel/test/run-task.test.sh
pnpm exec prettier --check BUILD.bazel .bazelrc .bazelversion .github/workflows/ci.yml README.md bazel/README.md
git diff --check
```

预期：测试通过、Prettier exit 0、无 whitespace error。若 Prettier 不支持 Bazel 文件，则只对 YAML/Markdown 运行 Prettier，并对 Bazel 文件使用 `buildifier -mode=check`（可用时）或 Bazel parse/query 验证。

- [ ] **步骤 4：提交阶段成果**

```bash
git add .github/workflows/ci.yml README.md bazel/README.md
git commit -m "ci(构建): 使用 Bazel 统一任务入口"
```

### 任务 4：整体审查、性能与健壮性收口

**文件：**
- 修改：仅限审查发现确有必要的上述文件

- [ ] **步骤 1：规格审查**

逐项对照设计文档，确认七个目标、CI 平台拆分、环境透传、非 hermetic 文档和非目标均满足；删除任何超范围功能。

- [ ] **步骤 2：代码质量审查**

重点检查 shell quoting、退出码传递、命令注入、工作目录、并发/锁、后台子进程与重复进程。适配器必须以 `exec pnpm` 替换自身，保持单个额外 Bazel launcher 的最小开销。

- [ ] **步骤 3：最终验证**

重新运行：

```bash
bash bazel/test/run-task.test.sh
bash -n bazel/run-task.sh bazel/test/run-task.test.sh
pnpm lint
pnpm typecheck
pnpm test
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001 pnpm build
git diff --check
git status --short
```

在 Bazel 可用时额外运行 `bazel query '//:*'` 和至少一个真实 `bazel run`。完整读取退出码和失败数；任何失败都必须修复或作为明确的环境阻塞报告。

- [ ] **步骤 4：保留最终改动供用户审阅**

任务 4 产生的最终 review 修订不得提交。最终报告列出已有阶段 commit、未提交 diff、实际验证命令和任何环境限制。
