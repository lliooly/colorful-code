#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_TASK="$(cd "$SCRIPT_DIR/.." && pwd)/run-task.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_DIR="$TMP_DIR/bin"
EMPTY_BIN_DIR="$TMP_DIR/empty-bin"
WORKSPACE_DIR="$TMP_DIR/workspace with spaces"
PNPM_LOG="$TMP_DIR/pnpm.log"
PWD_LOG="$TMP_DIR/pwd.log"
mkdir -p "$BIN_DIR" "$EMPTY_BIN_DIR" "$WORKSPACE_DIR"

cat >"$BIN_DIR/pnpm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$PNPM_LOG"
printf '%s\n' "$PWD" >"$PWD_LOG"
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

run_adapter() {
  local stdout_file="$TMP_DIR/stdout"
  local stderr_file="$TMP_DIR/stderr"
  set +e
  BUILD_WORKSPACE_DIRECTORY="$WORKSPACE_DIR" \
    PNPM_LOG="$PNPM_LOG" \
    PWD_LOG="$PWD_LOG" \
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
assert_mapping lint $'turbo\nrun\nlint\n--filter=!@colorful-code/desktop'
assert_mapping typecheck $'turbo\nrun\ntypecheck\n--filter=!@colorful-code/desktop'
assert_mapping test $'run\ntest'
assert_mapping desktop-sidecar $'--filter\n@colorful-code/desktop\nbuild:server-sidecar'
assert_mapping desktop-check $'--filter\n@colorful-code/desktop\nlint'
assert_mapping desktop-test $'--filter\n@colorful-code/desktop\ntest'

set +e
(
  unset BUILD_WORKSPACE_DIRECTORY PNPM_EXIT
  PNPM_LOG="$PNPM_LOG" PWD_LOG="$PWD_LOG" PATH="$BIN_DIR:/usr/bin:/bin" \
    /bin/bash "$RUN_TASK" build >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
)
status=$?
set -e
assert_status 64 "$status" "missing workspace"
assert_stderr_equals "error: BUILD_WORKSPACE_DIRECTORY is required" "$(cat "$TMP_DIR/stderr")" "missing workspace"
pass_count=$((pass_count + 1))
printf 'ok - missing workspace rejected\n'

set +e
BUILD_WORKSPACE_DIRECTORY="$WORKSPACE_DIR" PNPM_LOG="$PNPM_LOG" PWD_LOG="$PWD_LOG" PNPM_EXIT=0 PATH="$EMPTY_BIN_DIR" \
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
  PNPM_EXIT=23 \
  PATH="$BIN_DIR:/usr/bin:/bin" \
  /bin/bash "$RUN_TASK" test >"$TMP_DIR/stdout" 2>"$TMP_DIR/stderr"
status=$?
set -e
assert_status 23 "$status" "pnpm exit status"
assert_stderr_equals "" "$(cat "$TMP_DIR/stderr")" "pnpm exit status"
pass_count=$((pass_count + 1))
printf 'ok - pnpm exit status propagated\n'

printf '%s tests passed\n' "$pass_count"
