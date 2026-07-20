#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_TASK="$(cd "$SCRIPT_DIR/.." && pwd)/run-task.sh"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_DIR="$TMP_DIR/bin"
EMPTY_BIN_DIR="$TMP_DIR/empty-bin"
WORKSPACE_DIR="$TMP_DIR/workspace with spaces"
PNPM_LOG="$TMP_DIR/pnpm.log"
PWD_LOG="$TMP_DIR/pwd.log"
ENV_LOG="$TMP_DIR/env.log"
API_BASE_URL_SENTINEL='http://127.0.0.1:3999'
mkdir -p "$BIN_DIR" "$EMPTY_BIN_DIR" "$WORKSPACE_DIR"

cat >"$BIN_DIR/pnpm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$PNPM_LOG"
printf '%s\n' "$PWD" >"$PWD_LOG"
printf '%s\n' "${NEXT_PUBLIC_API_BASE_URL-}" >"$ENV_LOG"
exit "${PNPM_EXIT:-0}"
MOCK
chmod +x "$BIN_DIR/pnpm"

pass_count=0

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  [[ "$actual" -eq "$expected" ]] || fail "$context: expected status $expected, got $actual"
}

assert_file_equals() {
  local expected="$1"
  local file="$2"
  local context="$3"
  local actual
  actual="$(cat "$file")"
  [[ "$actual" == "$expected" ]] || fail "$context: argv mismatch; expected [$expected], got [$actual]"
}

assert_stderr_equals() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  [[ "$actual" == "$expected" ]] || fail "$context: expected stderr [$expected], got [$actual]"
}

assert_file_content_equals() {
  local expected="$1"
  local file="$2"
  local context="$3"
  local actual
  [[ -f "$file" ]] || fail "$context: missing file $file"
  actual="$(cat "$file")"
  [[ "$actual" == "$expected" ]] || fail "$context: unexpected declarations in $file"
}

assert_active_lines_equal() {
  local expected="$1"
  local file="$2"
  local context="$3"
  local actual
  [[ -f "$file" ]] || fail "$context: missing file $file"
  actual="$(awk 'NF && $1 !~ /^#/' "$file")"
  [[ "$actual" == "$expected" ]] || fail "$context: unexpected active configuration in $file"
}

assert_file_contains() {
  local expected="$1"
  local file="$2"
  local context="$3"
  grep -Fq -- "$expected" "$file" || fail "$context: missing [$expected] in $file"
}

run_adapter() {
  local stdout_file="$TMP_DIR/stdout"
  local stderr_file="$TMP_DIR/stderr"
  set +e
  BUILD_WORKSPACE_DIRECTORY="$WORKSPACE_DIR" \
    PNPM_LOG="$PNPM_LOG" \
    PWD_LOG="$PWD_LOG" \
    ENV_LOG="$ENV_LOG" \
    NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL_SENTINEL" \
    PNPM_EXIT=0 \
    PATH="$BIN_DIR:/usr/bin:/bin" \
    /bin/bash "$RUN_TASK" "$@" >"$stdout_file" 2>"$stderr_file"
  RUN_STATUS=$?
  set -e
  RUN_STDERR="$(cat "$stderr_file")"
}

assert_mapping() {
  local task="$1"
  local expected="$2"
  : >"$PNPM_LOG"
  : >"$PWD_LOG"
  run_adapter "$task"
  assert_status 0 "$RUN_STATUS" "$task mapping"
  assert_stderr_equals "" "$RUN_STDERR" "$task mapping"
  assert_file_equals "$expected" "$PNPM_LOG" "$task mapping"
  assert_file_equals "$WORKSPACE_DIR" "$PWD_LOG" "$task working directory"
  pass_count=$((pass_count + 1))
  printf 'ok - %s mapping\n' "$task"
}

assert_mapping build $'turbo\nrun\nbuild\n--filter=!@colorful-code/desktop'
assert_file_equals "$API_BASE_URL_SENTINEL" "$ENV_LOG" "build environment"
assert_mapping lint $'turbo\nrun\nlint\n--filter=!@colorful-code/desktop'
assert_mapping typecheck $'turbo\nrun\ntypecheck\n--filter=!@colorful-code/desktop'
assert_mapping test $'run\ntest'
assert_mapping desktop-sidecar $'--filter\n@colorful-code/desktop\nbuild:server-sidecar'
assert_mapping desktop-check $'--filter\n@colorful-code/desktop\nlint'
assert_mapping desktop-test $'--filter\n@colorful-code/desktop\ntest'

set +e
(
  unset BUILD_WORKSPACE_DIRECTORY PNPM_EXIT
  PNPM_LOG="$PNPM_LOG" PWD_LOG="$PWD_LOG" ENV_LOG="$ENV_LOG" \
    NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL_SENTINEL" PATH="$BIN_DIR:/usr/bin:/bin" \
    /bin/bash "$RUN_TASK" build >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
)
status=$?
set -e
assert_status 64 "$status" "missing workspace"
assert_stderr_equals "error: BUILD_WORKSPACE_DIRECTORY is required" "$(cat "$TMP_DIR/stderr")" "missing workspace"
pass_count=$((pass_count + 1))
printf 'ok - missing workspace rejected\n'

set +e
BUILD_WORKSPACE_DIRECTORY="$WORKSPACE_DIR" PNPM_LOG="$PNPM_LOG" PWD_LOG="$PWD_LOG" ENV_LOG="$ENV_LOG" \
  NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL_SENTINEL" PNPM_EXIT=0 PATH="$EMPTY_BIN_DIR" \
  /bin/bash "$RUN_TASK" build >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
status=$?
set -e
assert_status 69 "$status" "missing pnpm"
assert_stderr_equals "error: pnpm was not found in PATH" "$(cat "$TMP_DIR/stderr")" "missing pnpm"
pass_count=$((pass_count + 1))
printf 'ok - missing pnpm rejected\n'

run_adapter unknown
assert_status 64 "$RUN_STATUS" "unknown task"
assert_stderr_equals "error: unknown task: unknown" "$RUN_STDERR" "unknown task"
pass_count=$((pass_count + 1))
printf 'ok - unknown task rejected\n'

run_adapter build extra
assert_status 64 "$RUN_STATUS" "extra argument"
assert_stderr_equals "error: expected exactly one task argument" "$RUN_STDERR" "extra argument"
pass_count=$((pass_count + 1))
printf 'ok - extra argument rejected\n'

set +e
BUILD_WORKSPACE_DIRECTORY="$WORKSPACE_DIR" \
  PNPM_LOG="$PNPM_LOG" \
  PWD_LOG="$PWD_LOG" \
  ENV_LOG="$ENV_LOG" \
  NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL_SENTINEL" \
  PNPM_EXIT=23 \
  PATH="$BIN_DIR:/usr/bin:/bin" \
  /bin/bash "$RUN_TASK" test >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
status=$?
set -e
assert_status 23 "$status" "pnpm exit status"
assert_stderr_equals "" "$(cat "$TMP_DIR/stderr")" "pnpm exit status"
pass_count=$((pass_count + 1))
printf 'ok - pnpm exit status propagated\n'

# Launcher blocks remain a precise public contract; supporting npm targets are checked separately.
expected_launcher_blocks=$'sh_binary(\n    name = "build",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["build"],\n    visibility = ["//visibility:public"],\n)\nsh_binary(\n    name = "lint",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["lint"],\n    visibility = ["//visibility:public"],\n)\nsh_binary(\n    name = "typecheck",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["typecheck"],\n    visibility = ["//visibility:public"],\n)\nsh_binary(\n    name = "test",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["test"],\n    visibility = ["//visibility:public"],\n)\nsh_binary(\n    name = "desktop-sidecar",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["desktop-sidecar"],\n    visibility = ["//visibility:public"],\n)\nsh_binary(\n    name = "desktop-check",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["desktop-check"],\n    visibility = ["//visibility:public"],\n)\nsh_binary(\n    name = "desktop-test",\n    srcs = ["//bazel:run-task.sh"],\n    args = ["desktop-test"],\n    visibility = ["//visibility:public"],\n)'
actual_launcher_blocks="$(awk '/^sh_binary\($/{in_rule=1} in_rule{if (NF) print} in_rule && /^\)$/{in_rule=0}' "$WORKSPACE_ROOT/BUILD.bazel")"
[[ "$actual_launcher_blocks" == "$expected_launcher_blocks" ]] || fail "root orchestration targets: launcher declarations changed"

expected_root_support=$'load("@npm//:defs.bzl", "npm_link_all_packages")\nload("@rules_shell//shell:sh_binary.bzl", "sh_binary")\nexports_files([\n    ".npmrc",\n    "package.json",\n    "pnpm-lock.yaml",\n    "pnpm-workspace.yaml",\n])\nnpm_link_all_packages(name = "node_modules")'
actual_root_support="$(awk '/^sh_binary\($/{in_rule=1} !in_rule && NF{print} in_rule && /^\)$/{in_rule=0}' "$WORKSPACE_ROOT/BUILD.bazel")"
[[ "$actual_root_support" == "$expected_root_support" ]] || fail "root support targets: unexpected declarations"
pass_count=$((pass_count + 1))
printf 'ok - exactly seven orchestration targets share the adapter\n'

for dependency in \
  'bazel_dep(name = "rules_shell", version = "0.8.0")' \
  'bazel_dep(name = "aspect_rules_js", version = "3.2.3")' \
  'bazel_dep(name = "aspect_rules_ts", version = "3.8.11")' \
  'bazel_dep(name = "rules_nodejs", version = "6.7.3")'; do
  assert_file_contains "$dependency" "$WORKSPACE_ROOT/MODULE.bazel" "Bazel module dependencies"
done
assert_file_contains 'module_name = "aspect_rules_js"' "$WORKSPACE_ROOT/MODULE.bazel" "private rules_js adapter pin"
assert_file_contains 'version = "3.2.3"' "$WORKSPACE_ROOT/MODULE.bazel" "private rules_js adapter pin"
if ! awk '
  /single_version_override\(/ { in_override = 1 }
  in_override && /module_name = "aspect_rules_js"/ { has_module = 1 }
  in_override && /version = "3.2.3"/ { has_version = 1 }
  in_override && /^\)/ { exit !(has_module && has_version) }
  END { exit !(has_module && has_version) }
' "$WORKSPACE_ROOT/MODULE.bazel"; then
  fail "private rules_js adapter pin: override is not exact"
fi
assert_file_contains 'node.toolchain(node_version = "22.22.0")' "$WORKSPACE_ROOT/MODULE.bazel" "hermetic Node toolchain"
assert_file_contains 'register_toolchains("@nodejs_toolchains//:all")' "$WORKSPACE_ROOT/MODULE.bazel" "hermetic Node toolchain"
assert_file_contains 'pnpm_lock = "//:pnpm-lock.yaml"' "$WORKSPACE_ROOT/MODULE.bazel" "npm lock translation"
assert_file_contains 'data = ["//:pnpm-workspace.yaml"]' "$WORKSPACE_ROOT/MODULE.bazel" "npm workspace translation"
assert_file_contains 'npmrc = "//:.npmrc"' "$WORKSPACE_ROOT/MODULE.bazel" "npm registry configuration"
assert_file_contains 'bins = {"typescript": ["tsc=bin/tsc"]}' "$WORKSPACE_ROOT/MODULE.bazel" "TypeScript npm binary"
if grep -Eq 'npm_typescript|aspect_rules_ts.*extensions|ext\.deps' "$WORKSPACE_ROOT/MODULE.bazel"; then
  fail "Bazel module declares a second TypeScript/npm resolution source"
fi
pass_count=$((pass_count + 1))
printf 'ok - Bazel module pins JS/TS/Node dependencies and one npm resolution source\n'

assert_file_content_equals 'ignore_directories(["**/node_modules"])' "$WORKSPACE_ROOT/REPO.bazel" "Bazel repository crawl exclusions"
pass_count=$((pass_count + 1))
printf 'ok - Bazel ignores every node_modules directory during repository crawl\n'

[[ -f "$WORKSPACE_ROOT/MODULE.bazel.lock" ]] || fail "Bazel module lockfile is missing"
pass_count=$((pass_count + 1))
printf 'ok - Bazel module lockfile exists\n'

bazel_command=""
if command -v bazel >/dev/null 2>&1; then
  bazel_command="bazel"
elif command -v bazelisk >/dev/null 2>&1; then
  bazel_command="bazelisk"
fi

if [[ -n "$bazel_command" ]]; then
  lock_checksum_before="$(cksum "$WORKSPACE_ROOT/MODULE.bazel.lock")"
  expected_query=$'sh_binary rule //:build\nsh_binary rule //:desktop-check\nsh_binary rule //:desktop-sidecar\nsh_binary rule //:desktop-test\nsh_binary rule //:lint\nsh_binary rule //:test\nsh_binary rule //:typecheck'
  actual_query="$(cd "$WORKSPACE_ROOT" && "$bazel_command" --ignore_all_rc_files query --repo_env=ASPECT_TOOLS_TELEMETRY=-all --lockfile_mode=error --order_output=full --output=label_kind '//:*' | LC_ALL=C sort)"
  actual_launchers="$(printf '%s\n' "$actual_query" | awk '$1 == "sh_binary" && $2 == "rule"')"
  [[ "$actual_launchers" == "$expected_query" ]] || fail "Bazel query: unexpected launcher target graph"
  if ! printf '%s\n' "$actual_query" | awk '$NF == "//:node_modules" { found = 1 } END { exit found ? 0 : 1 }'; then
    fail "Bazel query: npm support target is missing"
  fi
  workspace_query="$(cd "$WORKSPACE_ROOT" && "$bazel_command" --ignore_all_rc_files query --repo_env=ASPECT_TOOLS_TELEMETRY=-all --lockfile_mode=error --output=label '//...' | LC_ALL=C sort)"
  if printf '%s\n' "$workspace_query" | awk '$0 == "//node_modules" || index($0, "//node_modules/") == 1 || index($0, "//node_modules:") == 1 { found = 1 } END { exit found ? 0 : 1 }'; then
    fail "Bazel query crawled a node_modules directory"
  fi
  pass_count=$((pass_count + 1))
  printf 'ok - Bazel query reports seven sh_binary targets\n'

  (
    cd "$WORKSPACE_ROOT"
    NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL_SENTINEL" \
      "$bazel_command" --ignore_all_rc_files build --repo_env=ASPECT_TOOLS_TELEMETRY=-all --lockfile_mode=error \
      //:build //:lint //:typecheck //:test \
      //:desktop-sidecar //:desktop-check //:desktop-test
  )
  pass_count=$((pass_count + 1))
  printf 'ok - Bazel builds all seven sh_binary launchers\n'

  : >"$PNPM_LOG"
  : >"$PWD_LOG"
  : >"$ENV_LOG"
  set +e
  (
    cd "$WORKSPACE_ROOT"
    PNPM_LOG="$PNPM_LOG" PWD_LOG="$PWD_LOG" ENV_LOG="$ENV_LOG" \
      NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL_SENTINEL" PNPM_EXIT=0 PATH="$BIN_DIR:$PATH" \
      "$bazel_command" --ignore_all_rc_files run --repo_env=ASPECT_TOOLS_TELEMETRY=-all --lockfile_mode=error //:build
  ) >"$TMP_DIR/bazel-run-stdout" 2>"$TMP_DIR/bazel-run-stderr"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    cat "$TMP_DIR/bazel-run-stderr" >&2
    fail "Bazel build run: expected status 0, got $status"
  fi
  assert_file_equals $'turbo\nrun\nbuild\n--filter=!@colorful-code/desktop' "$PNPM_LOG" "Bazel build run"
  assert_file_equals "$WORKSPACE_ROOT" "$PWD_LOG" "Bazel build working directory"
  assert_file_equals "$API_BASE_URL_SENTINEL" "$ENV_LOG" "Bazel build environment"
  pass_count=$((pass_count + 1))
  printf 'ok - Bazel build target executes through the mock adapter with its runtime environment\n'

  lock_checksum_after="$(cksum "$WORKSPACE_ROOT/MODULE.bazel.lock")"
  [[ "$lock_checksum_after" == "$lock_checksum_before" ]] || fail "Bazel commands changed MODULE.bazel.lock"
  pass_count=$((pass_count + 1))
  printf 'ok - Bazel commands leave the module lock unchanged\n'
else
  if [[ "${REQUIRE_BAZEL:-0}" == "1" ]]; then
    fail "Bazel is required but neither bazel nor bazelisk is available"
  fi
  printf 'ok - Bazel query/build/run skipped (bazel unavailable)\n'
fi

expected_bazel_build=$'exports_files(\n    ["run-task.sh"],\n    visibility = ["//visibility:public"],\n)'
assert_file_content_equals "$expected_bazel_build" "$WORKSPACE_ROOT/bazel/BUILD.bazel" "adapter export"
pass_count=$((pass_count + 1))
printf 'ok - adapter is exported publicly\n'

assert_file_content_equals '9.1.0' "$WORKSPACE_ROOT/.bazelversion" "Bazel version"
pass_count=$((pass_count + 1))
printf 'ok - Bazel version is pinned\n'

expected_bazelrc=$'build --enable_bzlmod\ncommon --announce_rc\ncommon --repo_env=ASPECT_TOOLS_TELEMETRY=-all\nrun --action_env=NEXT_PUBLIC_API_BASE_URL'
assert_active_lines_equal "$expected_bazelrc" "$WORKSPACE_ROOT/.bazelrc" "Bazel rc"
pass_count=$((pass_count + 1))
printf 'ok - Bazel rc contains only required settings\n'

printf '%s tests passed\n' "$pass_count"
