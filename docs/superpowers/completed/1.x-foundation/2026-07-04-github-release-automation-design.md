# GitHub Release Automation Design

## Goal

Automate macOS desktop packaging for Colorful Code through GitHub Actions and attach the packaged app to GitHub Releases.

The first release pipeline should optimize for getting a repeatable artifact out of CI. Apple code signing and notarization are intentionally out of scope until the required Apple Developer credentials are available.

## Scope

- Add a dedicated GitHub Actions release workflow.
- Build the macOS desktop app on a GitHub-hosted macOS runner.
- Support both version tag releases and manual workflow runs.
- Upload a zipped `.app` bundle to the matching GitHub Release.
- Keep the existing CI workflow unchanged.

## Release Triggers

The workflow runs in two cases:

- `push` tags matching `v*`, such as `v0.1.0`.
- `workflow_dispatch` for manual release testing or emergency reruns.

Tag-triggered runs publish against the pushed tag. Manual runs use the selected ref from GitHub Actions.

## Build Environment

The workflow uses `macos-14` so the generated artifact matches the current Apple Silicon development path. It installs:

- Node.js 22
- pnpm through `pnpm/action-setup`
- Rust stable through `rustup`
- Bun through `oven-sh/setup-bun`

Dependencies are installed with `pnpm install --frozen-lockfile`.

## Packaging Flow

The workflow runs:

```sh
pnpm package:macos
```

This calls `pnpm --filter @colorful-code/desktop package:macos`, which currently runs:

```sh
tauri build --bundles app
```

The expected output is:

```text
apps/desktop/src-tauri/target/release/bundle/macos/Colorful Code.app
```

The workflow zips that `.app` bundle into a stable release asset name:

```text
Colorful-Code-macos-arm64.zip
```

## Release Publishing

The workflow grants `contents: write` only for the release job. It uses the repository `GITHUB_TOKEN` to create or update the GitHub Release and upload the zip asset.

For tag-triggered runs, the release name is the tag name. For manual runs, the workflow can upload to the selected ref, but tag-triggered runs remain the intended production path.

## Error Handling

- If dependency installation fails, the workflow stops before packaging.
- If Tauri packaging fails, no release asset is uploaded.
- If the expected `.app` bundle is missing, the workflow fails with a clear error before creating the zip.
- Re-running a release for the same tag replaces the existing zip asset.

## Out Of Scope

- Apple Developer ID signing.
- macOS notarization.
- DMG generation.
- Windows or Linux desktop builds.
- Tauri updater metadata.

These can be added later after the unsigned macOS release path is stable.

## Verification

Implementation should be verified by:

- Checking the workflow YAML syntax locally.
- Confirming the expected Tauri output path still matches the repository config.
- Running a local packaging command if practical.
- Optionally pushing a test tag after the workflow lands.
