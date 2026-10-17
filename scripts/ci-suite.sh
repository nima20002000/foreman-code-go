#!/bin/bash
# The existing CI part names remain stable. Backend parts always check the full Go module.
#   *-api: Go; *-other and unit-web*: retained TypeScript; root names: both.
#   integration: Go integration tests, Go conformance, and the TS oracle when conformance changes.
# start prepares cached tools asynchronously; prepare does the same synchronously on a build computer.
set -euo pipefail
case "${SUITE:-}" in
  unit|unit-*)
    if [ -n "${1:-}" ]; then
      SUITE=lint bash scripts/ci-go-toolchain.sh install
    else
      source scripts/ci-go-toolchain.sh
      ci_go_environment
      ci_go_verify
      node scripts/ci-capture-format.mjs
    fi
    exit 0 ;;
esac
umask 077
script_directory="$(cd "$(dirname "$0")" && pwd)"
case "${CI_PARTITION:-}" in
  sha256:*) exec node "$script_directory/ci-selection.mjs" --dispatch-inputs "$0" "$@" ;;
esac
if [ "${CI_WATCHDOG_ACTIVE:-}" != 1 ] && [ -n "${CI_EXPECTED_DURATION_MS:-}" ] && [ -z "${1:-}" ]; then
  case "${SUITE:-}" in unit|unit-*|integration) exec node "$script_directory/ci-watchdog.mjs" -- bash "$0" ;; esac
fi

# The host runner uses the older integration aliases for its root-script entry point.
test_results="${TEST_RESULTS_OUTPUT:-${FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT:-}}"
durations_output="${DURATIONS_OUTPUT:-${FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT:-}}"
unset TEST_RESULTS_OUTPUT FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT DURATIONS_OUTPUT
unset BASH_ENV ENV
export CI_STATE="$(realpath -m "${CI_STATE:-${FOREMAN_CODE_CI_DATABASE_STATE:-${TMPDIR:-/tmp}}/foreman-ci-state}")"
state="$CI_STATE"
mkdir -p "$state"
chmod 700 "$state"

# Keep only tool caches shared. Every check, including retained TS tests, gets this job's empty home.
export FOREMAN_CODE_CI_GO_CACHE="$(realpath -m "${FOREMAN_CODE_CI_GO_CACHE:-$HOME/.cache/foreman-go}")"
export COREPACK_HOME="$(realpath -m "${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}")"
export HOME="$state/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_STATE_HOME="$HOME/.local/state" XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
chmod 700 "$HOME"
unset DATABASE_URL TEST_DATABASE_URL FOREMAN_CODE_CI_TEST_ADMIN_URL
unset GRAPHQL_DATABASE_URL GRAPHQL_TEST_DATABASE_URL GRAPHQL_CI_TEST_ADMIN_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
unset FOREMAN_CODE_API_ENV_FILE GRAPHQL_API_ENV_FILE PGSERVICE PGSERVICEFILE PGPASSFILE PGHOSTADDR
pnpm() { corepack pnpm "$@"; }

process_started_at() {
  local process="$1" status
  [ -r "/proc/$process/stat" ] || return 1
  # A completed preparation can disappear between the existence check and read.
  if ! read -r status < "/proc/$process/stat"; then return 1; fi
  local fields=()
  read -r -a fields <<< "${status##*) }"
  printf '%s\n' "${fields[19]}"
}

preparation_running() {
  local name="$1" process started actual
  [ ! -f "$state/$name.exit" ] && [ -f "$state/$name.process" ] || return 1
  read -r process started < "$state/$name.process" || return 1
  [[ "$process" =~ ^[0-9]+$ && "$started" =~ ^[0-9]+$ ]] && [ "$process" -gt 1 ] || return 1
  actual="$(process_started_at "$process")" || return 1
  [ "$actual" = "$started" ]
}

wait_preparation() {
  local name="$1" seconds="$2" deadline
  deadline=$((SECONDS + seconds))
  while preparation_running "$name"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "$name preparation is still reconciling; retaining its private HOME for cleanup." >&2
      return 1
    fi
    sleep 0.5
  done
}

stop_go_preparation() {
  preparation_running go || return 0
  local process started
  read -r process started < "$state/go.process" || return 1
  # The identity check includes start time, so it cannot target a reused PID.
  if ! kill -TERM -- "-$process"; then
    preparation_running go || return 0
    echo 'Unable to stop Go preparation.' >&2
    return 1
  fi
  wait_preparation go 5
}

cleanup() {
  local code=$? retain_home=0
  trap - EXIT
  # Successful preparation leaves its private state for the later suite invocation.
  if [ "$code" = 0 ] && { [ "${1:-}" = start ] || [ "${1:-}" = prepare ]; }; then return 0; fi
  if [ "${SUITE:-}" = integration ]; then
    # Cancel while the starter is alive. Its Docker RPC may finish after this first exact cleanup.
    node "$script_directory/ci-go-prerequisites.mjs" database-stop || { if [ "$code" = 0 ]; then code=1; fi; }
    wait_preparation db 170 || { retain_home=1; if [ "$code" = 0 ]; then code=1; fi; }
    node "$script_directory/ci-go-prerequisites.mjs" database-stop || { if [ "$code" = 0 ]; then code=1; fi; }
  fi
  stop_go_preparation || { retain_home=1; if [ "$code" = 0 ]; then code=1; fi; }
  if [ "$retain_home" = 0 ]; then rm -rf "$HOME" || { if [ "$code" = 0 ]; then code=1; fi; }; fi
  exit "$code"
}
trap 'cleanup "${1:-}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "${1:-}" ] && [ -n "${FOREMAN_CODE_CI_TYPECHECK_CACHE:-}" ] \
  && [ "${FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE:-}" != 1 ]; then
  case "${SUITE:-}" in
    typecheck|typecheck-other) exec node "$script_directory/ci-typecheck-cache.mjs" -- bash "$0" ;;
  esac
fi

go_part=0
case "${SUITE:-}" in
  typecheck|typecheck-api|lint|lint-api|build|build-api|unit|unit-api|integration) go_part=1 ;;
esac
if [ "$go_part" = 1 ]; then
  source "$script_directory/ci-go-toolchain.sh"
  ci_go_environment
  source "$script_directory/ci-go-suite.sh"
fi

prepare_one() {
  local name="$1" code=0
  shift
  "$@" > "$state/$name.log" 2>&1 || code=$?
  cat "$state/$name.log"
  printf '%s\n' "$code" > "$state/$name.exit"
  return "$code"
}

background() {
  local name="$1"
  shift
  rm -f "$state/$name.exit" "$state/$name.process"
  # Positional arguments preserve spaces in cache/worktree paths and never become shell code.
  setsid nohup bash -c 'name="$1"; shift; "$@" > "$CI_STATE/$name.log" 2>&1; printf "%s\n" "$?" > "$CI_STATE/$name.exit"' \
    bash "$name" "$@" >/dev/null 2>&1 &
  local process=$! started
  if started="$(process_started_at "$process")"; then
    printf '%s %s\n' "$process" "$started" > "$state/$name.process"
  fi
}

if [ "${1:-}" = start ] || [ "${1:-}" = prepare ]; then
  if [ "$go_part" = 1 ]; then
    if [ "$1" = start ]; then
      background go bash "$script_directory/ci-go-toolchain.sh" install
    else
      prepare_one go bash "$script_directory/ci-go-toolchain.sh" install
    fi
  fi
  if [ "$SUITE" = integration ]; then
    if [ "$1" = start ]; then
      background db node "$script_directory/ci-go-prerequisites.mjs" database-start
    else
      prepare_one db node "$script_directory/ci-go-prerequisites.mjs" database-start
    fi
  fi
  exit 0
fi

ready() {
  [ "${CI_PREREQUISITES_UNTRACKED:-0}" != 1 ] || return 0
  [ -f "$state/$1.log" ] || { echo "Prerequisite $1 startup status is missing" >&2; return 1; }
  until [ -f "$state/$1.exit" ]; do sleep 0.5; done
  [ "$(cat "$state/$1.exit")" = 0 ] || { cat "$state/$1.log"; echo "$1 failed to start" >&2; return 1; }
}

# .go files and conformance are not understood by the frozen TS affected selector.
# Frontend duration shards remain supported, while Go ignores all supplied partitions and file indexes.
if [ "${SCOPE:-affected}" != full ]; then echo 'Running full fork CI scope, including the complete Go backend.'; fi
export SCOPE=full
unset SELECTED_FILES CI_PARTITION CI_SELECTION_COMMIT
if [ "$go_part" = 1 ]; then ready go; ci_go_verify; fi

reports=()
duration_reports=()
suite_code=0
run_check() {
  local code=0
  "$@" || code=$?
  if [ "$suite_code" = 0 ]; then suite_code="$code"; fi
}

build_contracts() {
  if [ -n "${FOREMAN_CODE_CI_CONTRACTS_CACHE:-}" ] && node scripts/ci-contracts.mjs ready "$PWD"; then return 0; fi
  pnpm --filter @foreman-code/contracts build
}

retained_check() {
  local kind="$1"
  build_contracts || return $?
  pnpm -r --no-bail --filter @foreman-code/contracts --filter @foreman-code/web "$kind" || return $?
  if [ "$kind" = typecheck ] && [ -f conformance/package.json ]; then pnpm --dir conformance typecheck; fi
}

unit_web() {
  local code=0 output="$state/unit-web.durations.json"
  local files=()
  build_contracts || return $?
  node scripts/ci-unit-files.mjs select unit-web "${SLICE:-}" > "$state/unit-files" || return $?
  mapfile -d '' -t files < "$state/unit-files"
  rm -f "$output" "$output.vitest.json"
  reports+=("$output.vitest.json")
  (cd apps/web && FOREMAN_WEB_TEST_PHASE=fast pnpm exec vitest run "${files[@]}" --reporter=default --reporter=json \
    "--reporter=$script_directory/ci-progress-reporter.mjs" "--outputFile.json=$output.vitest.json") || code=$?
  if [ -f "$output.vitest.json" ]; then
    node scripts/ci-unit-files.mjs record unit-web "$output.vitest.json" "$output" || { if [ "$code" = 0 ]; then code=1; fi; }
    if [ -f "$output" ]; then duration_reports+=("$output"); fi
  fi
  return "$code"
}

unit_web_heavy() {
  local code=0 status report="$state/unit-web-heavy.vitest.json"
  build_contracts || return $?
  case "${SLICE:-1/1}" in 1/*) pnpm --filter @foreman-code/web test:run-graph-smoke || code=$? ;; esac
  rm -f "$report"
  reports+=("$report")
  (cd apps/web && FOREMAN_WEB_TEST_PHASE=heavy pnpm exec vitest run ${SLICE:+--shard=$SLICE} \
    --reporter=default --reporter=json "--reporter=$script_directory/ci-progress-reporter.mjs" \
    "--outputFile.json=$report") || { status=$?; if [ "$code" = 0 ]; then code="$status"; fi; }
  return "$code"
}

node_tests() {
  local report="$1"; shift
  pnpm exec node --test --test-reporter=spec --test-reporter-destination=stdout \
    "--test-reporter=$script_directory/ci-node-test-reporter.mjs" "--test-reporter-destination=$report" "$@"
}

unit_other() {
  local code=0 status directory="$state/unit-other"
  mkdir -p "$directory"
  rm -f "$directory/contracts.json" "$directory/scripts.json"
  build_contracts || return $?
  reports+=("$directory/contracts.json" "$directory/scripts.json")
  pnpm --filter @foreman-code/contracts test --reporter=default --reporter=json \
    "--outputFile.json=$directory/contracts.json" || code=$?
  node_tests "$directory/scripts.json" 'scripts/**/*.test.mjs' || { status=$?; if [ "$code" = 0 ]; then code="$status"; fi; }
  return "$code"
}

case "${SUITE:-}" in
  install) ;;
  typecheck-api) run_check ci_go_typecheck ;;
  typecheck-other) run_check retained_check typecheck ;;
  typecheck) run_check ci_go_typecheck; run_check retained_check typecheck ;;
  lint-api) run_check ci_go_lint ;;
  lint-other) run_check retained_check lint ;;
  lint) run_check ci_go_lint; run_check retained_check lint ;;
  build-api) run_check ci_go_build ;;
  build-other) run_check retained_check build ;;
  build) run_check ci_go_build; run_check retained_check build ;;
  unit-api) run_check ci_go_test unit ;;
  unit-web) run_check unit_web ;;
  unit-web-heavy) run_check unit_web_heavy ;;
  unit-other) run_check unit_other ;;
  unit) unset SLICE; run_check ci_go_test unit; run_check unit_web; run_check unit_web_heavy; run_check unit_other ;;
  integration)
    ready db
    database_environment="$(node scripts/ci-go-prerequisites.mjs database-env)"
    eval "$database_environment"
    run_check ci_go_test integration
    run_check ci_conformance_test go
    if ci_conformance_changed; then run_check ci_conformance_test ts; fi ;;
  *) echo "Unknown suite ${SUITE:-}" >&2; exit 2 ;;
esac

if [ -n "$test_results" ] && [ "${#reports[@]}" -gt 0 ]; then
  available_reports=()
  for report in "${reports[@]}"; do
    if [ -f "$report" ]; then
      available_reports+=("$report")
    else
      echo "Expected test report is missing: $report" >&2
      if [ "$suite_code" = 0 ]; then suite_code=1; fi
    fi
  done
  if [ "${#available_reports[@]}" -gt 0 ]; then
    run_check node scripts/ci-test-results.mjs "$test_results" "${available_reports[@]}"
  fi
fi
if [ -n "$durations_output" ] && [ "${#duration_reports[@]}" -gt 0 ]; then
  run_check node scripts/ci-unit-files.mjs merge "$durations_output" "${duration_reports[@]}"
fi
exit "$suite_code"
