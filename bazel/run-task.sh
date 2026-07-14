#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  printf 'error: expected exactly one task argument\n' >&2
  exit 64
fi

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  printf 'error: BUILD_WORKSPACE_DIRECTORY is required\n' >&2
  exit 64
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'error: pnpm was not found in PATH\n' >&2
  exit 69
fi

cd "$BUILD_WORKSPACE_DIRECTORY"

case "$1" in
  build)
    exec pnpm turbo run build '--filter=!@colorful-code/desktop'
    ;;
  lint)
    exec pnpm turbo run lint '--filter=!@colorful-code/desktop'
    ;;
  typecheck)
    exec pnpm turbo run typecheck '--filter=!@colorful-code/desktop'
    ;;
  test)
    exec pnpm run test
    ;;
  desktop-sidecar)
    exec pnpm --filter @colorful-code/desktop build:server-sidecar
    ;;
  desktop-check)
    exec pnpm --filter @colorful-code/desktop lint
    ;;
  desktop-test)
    exec pnpm --filter @colorful-code/desktop test
    ;;
  *)
    printf 'error: unknown task: %s\n' "$1" >&2
    exit 64
    ;;
esac
