# GitHub Release Automation 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 添加 GitHub Actions release workflow，让 `v*` tag 或手动触发可以在 GitHub macOS runner 上打包 Colorful Code 并发布 zip 产物到 GitHub Releases。

**架构：** 新增独立的 `.github/workflows/release.yml`，不修改现有 CI。工作流解析 `v*` release tag，安装 Node.js、pnpm、Rust 和 Bun，运行仓库现有 `pnpm package:macos`，校验 Tauri `.app` 输出存在，再用 `ditto` 生成稳定命名的 zip，最后通过 GitHub Release action 上传或替换资产。

**技术栈：** GitHub Actions、macOS 14 runner、pnpm 11、Node.js 22、Rust stable、Bun、Tauri 2、softprops/action-gh-release。

---

### 任务 1：新增 release workflow

**文件：**

- 创建：`.github/workflows/release.yml`
- 参考：`package.json`
- 参考：`apps/desktop/package.json`
- 参考：`docs/superpowers/specs/2026-07-04-github-release-automation-design.md`

- [x] **步骤 1：创建工作流文件**

创建 `.github/workflows/release.yml`，内容包含：

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag_name:
        description: Existing release tag to publish, such as v0.1.0. Defaults to the selected ref.
        required: false
        type: string

concurrency:
  group: release-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: write

jobs:
  macos:
    name: Build unsigned macOS app
    runs-on: macos-14

    steps:
      - name: Resolve release tag
        id: release
        env:
          EVENT_NAME: ${{ github.event_name }}
          INPUT_TAG_NAME: ${{ inputs.tag_name }}
        run: |
          tag="$GITHUB_REF_NAME"

          if [ "$EVENT_NAME" = "workflow_dispatch" ] && [ -n "$INPUT_TAG_NAME" ]; then
            tag="$INPUT_TAG_NAME"
          fi

          if [[ "$tag" != v* ]]; then
            echo "::error::Release tag must start with v. Got '$tag'."
            exit 1
          fi

          echo "tag=$tag" >> "$GITHUB_OUTPUT"

      - name: Checkout
        uses: actions/checkout@v6
        with:
          ref: ${{ steps.release.outputs.tag }}

      - name: Install pnpm
        uses: pnpm/action-setup@v6

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm

      - name: Set up Rust
        run: |
          rustup toolchain install stable --profile minimal
          rustup default stable

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Package macOS app
        run: pnpm package:macos

      - name: Verify app bundle
        run: |
          test -d "apps/desktop/src-tauri/target/release/bundle/macos/Colorful Code.app"

      - name: Archive app bundle
        run: |
          ditto -c -k --keepParent \
            "apps/desktop/src-tauri/target/release/bundle/macos/Colorful Code.app" \
            "Colorful-Code-macos-arm64.zip"

      - name: Publish GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.release.outputs.tag }}
          name: ${{ steps.release.outputs.tag }}
          files: Colorful-Code-macos-arm64.zip
          fail_on_unmatched_files: true
          generate_release_notes: true
```

- [x] **步骤 2：运行 YAML 语法校验**

运行：

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release.yml")'
```

预期：命令退出码为 0，无 YAML 解析错误。

- [x] **步骤 3：如果本机安装了 actionlint，运行 workflow 校验**

运行：

```bash
if command -v actionlint >/dev/null 2>&1; then actionlint .github/workflows/release.yml; else echo "actionlint not installed; skipped"; fi
```

预期：已安装时无报错；未安装时输出跳过提示。

- [x] **步骤 4：确认产物路径与脚本仍匹配**

运行：

```bash
rg -n '"package:macos"|bundle/macos|Colorful Code.app' package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json .github/workflows/release.yml
```

预期：`package.json` 仍调用 `@colorful-code/desktop package:macos`，`apps/desktop/package.json` 仍执行 `tauri build --bundles app`，workflow 校验路径仍是 `apps/desktop/src-tauri/target/release/bundle/macos/Colorful Code.app`。

- [x] **步骤 5：查看变更范围**

运行：

```bash
git status --short .github/workflows/release.yml docs/superpowers/plans/2026-07-04-github-release-automation.md
```

预期：仅包含 release workflow 和本计划文档，不包含无关调试改动。
