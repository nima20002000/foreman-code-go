#!/bin/bash
# The existing CI part names remain stable. Affected requests bind exact files and native roots.
#   *-api: Go; *-other and unit-web*: retained TypeScript; root names: both.
#   integration: Go integration tests, Go conformance, and the TS oracle when conformance changes.
# start prepares cached tools asynchronously; prepare does the same synchronously on a build computer.
set -euo pipefail
umask 077
script_directory="$(cd "$(dirname "$0")" && pwd)"
cd "$script_directory/.."
if [ "${1:-}" = affected ]; then
  export SUITE="${2:?An affected action requires a suite}"
  export CI_AFFECTED_SELECTION_FILE="${3:?An affected action requires a selection file}"
  export SCOPE=affected
fi
if [ "${1:-}" != cleanup ]; then
  case "${CI_PARTITION:-}" in
    sha256:*) exec node "$script_directory/ci-selection.mjs" --dispatch-inputs "$0" "$@" ;;
  esac
fi

# The frozen host supplies integration --files only after parallel prepare/contracts setup.
# This phase makes no check claim. The later affected action must resolve and prepare its scope.
if [ "${1:-}" = prepare ] && [ "${SUITE:-}" = integration ] \
  && node "$script_directory/ci-affected-scope.mjs" deferred-host-integration; then
  echo '[ci-setup] integration setup deferred until the host supplies exact files'
  exit 0
fi
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
export FOREMAN_CODE_CI_POSTGRES_CACHE="$(realpath -m "${FOREMAN_CODE_CI_POSTGRES_CACHE:-$HOME/.cache/foreman-postgres}")"
export COREPACK_HOME="$(realpath -m "${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}")"
source "$script_directory/ci-runtime-state.sh"
unset DATABASE_URL TEST_DATABASE_URL FOREMAN_CODE_DATABASE_URL FOREMAN_CODE_TEST_DATABASE_URL FOREMAN_CODE_CI_TEST_ADMIN_URL
unset GRAPHQL_DATABASE_URL GRAPHQL_TEST_DATABASE_URL GRAPHQL_CI_TEST_ADMIN_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
unset FOREMAN_CODE_API_ENV_FILE GRAPHQL_API_ENV_FILE PGSERVICE PGSERVICEFILE PGPASSFILE PGHOSTADDR
unset GRAPHQL_CI_HOST_RUN_ID
unset CONFORMANCE_GO_BINARY CONFORMANCE_POSTGRES_BIN_DIR
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

stop_tool_preparation() {
  local name="$1" process started
  preparation_running "$name" || return 0
  read -r process started < "$state/$name.process" || return 1
  # The identity check includes start time, so it cannot target a reused PID.
  if ! kill -TERM -- "-$process"; then
    preparation_running "$name" || return 0
    echo "Unable to stop $name preparation." >&2
    return 1
  fi
  wait_preparation "$name" 5
}

cleanup() {
  local code=$? retain_home=0 descriptor
  trap - EXIT
  if [ "$code" = 0 ] && [ "${1:-}" = start ]; then return 0; fi
  if [ "$code" = 0 ] && [ "${1:-}" = prepare ]; then
    case "${SUITE:-}" in integration|unit|unit-other) return 0 ;; esac
  fi
  # Suite, host and provider cleanup share one lock from loading the current record through removal.
  # Synchronous non-database preparation also releases its runtime through this path.
  exec {descriptor}> "$state/runtime-cleanup.lock" || { if [ "$code" = 0 ]; then code=1; fi; exit "$code"; }
  flock --exclusive "$descriptor" || { if [ "$code" = 0 ]; then code=1; fi; exit "$code"; }
  ci_runtime_load || { if [ "$code" = 0 ]; then code=1; fi; exit "$code"; }
  if [ -n "$ci_runtime_root" ]; then ci_runtime_environment; fi
  if [ "${1:-}" = cleanup ] || [ "${SUITE:-}" = integration ] || [ "${SUITE:-}" = unit ] || [ "${SUITE:-}" = unit-other ]; then
    # Mark both profiles while starters are alive. A delayed Docker RPC can finish after the first cleanup.
    node "$script_directory/ci-go-prerequisites.mjs" databases-stop || { if [ "$code" = 0 ]; then code=1; fi; }
    local database
    for database in db scripts-db; do
      wait_preparation "$database" 170 || { retain_home=1; if [ "$code" = 0 ]; then code=1; fi; }
    done
    node "$script_directory/ci-go-prerequisites.mjs" databases-stop || { if [ "$code" = 0 ]; then code=1; fi; }
  fi
  local tool
  for tool in go postgres; do
    stop_tool_preparation "$tool" || { retain_home=1; if [ "$code" = 0 ]; then code=1; fi; }
  done
  if [ "$retain_home" = 0 ]; then ci_runtime_cleanup || { if [ "$code" = 0 ]; then code=1; fi; }; fi
  exit "$code"
}
trap 'cleanup "${1:-}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "${1:-}" = cleanup ]; then
  # Load only after the EXIT cleanup acquires the lifecycle lock.
  exit 0
fi

affected=1
go_selected=0
conformance_part=0
scripts_database=0
retained_part=0
case "${SCOPE:-affected}" in
  full)
    [ "${FOREMAN_CODE_CI_RELEASE:-}" = 1 ] || { echo 'Full CI scope is reserved for explicit release mode.' >&2; exit 2; }
    affected=0 ;;
  affected) ;;
  *) echo "Unsupported CI scope: ${SCOPE:-}" >&2; exit 2 ;;
esac
if [ "$affected" = 1 ] && [ "${SUITE:-}" != install ]; then
  TEST_RESULTS_OUTPUT="$test_results" node "$script_directory/ci-affected-scope.mjs" prepare "${SUITE:-}" "$state/affected-selection.json"
  export CI_AFFECTED_SELECTION_FILE="$state/affected-selection.json"
  export SCOPE=affected
  scope_flags="$(node "$script_directory/ci-affected-scope.mjs" flags "$CI_AFFECTED_SELECTION_FILE")"
  read -r go_selected conformance_part scripts_database retained_part <<< "$scope_flags"
fi
ci_runtime_initialize

if [ "$affected" = 0 ] && [ -z "${1:-}" ] && [ -n "${FOREMAN_CODE_CI_TYPECHECK_CACHE:-}" ] \
  && [ "${FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE:-}" != 1 ]; then
  case "${SUITE:-}" in
    typecheck|typecheck-other)
      cache_code=0
      node "$script_directory/ci-typecheck-cache.mjs" -- bash "$0" || cache_code=$?
      # The child normally cleans the shared runtime. Retain our trap for failures before it starts.
      exit "$cache_code" ;;
  esac
fi

go_part=0
integration_database=0
if [ "$affected" = 1 ]; then
  if [ "$go_selected" = 1 ] || [ "$conformance_part" = 1 ]; then go_part=1; fi
  if [ "${SUITE:-}" = integration ] && [ "$go_selected" = 1 ]; then integration_database=1; fi
else
  case "${SUITE:-}" in
    typecheck|typecheck-api|lint|lint-api|build|build-api|unit|unit-api|integration) go_part=1 ;;
  esac
  if [ "${SUITE:-}" = integration ]; then conformance_part=1; integration_database=1; fi
  case "${SUITE:-}" in unit|unit-other) scripts_database=1 ;; esac
fi
if [ "$go_part" = 1 ]; then
  source "$script_directory/ci-go-toolchain.sh"
  ci_go_environment
  source "$script_directory/ci-go-suite.sh"
fi
if [ "$conformance_part" = 1 ]; then
  source "$script_directory/ci-postgres-toolchain.sh"
  ci_postgres_environment
  source "$script_directory/ci-conformance-suite.sh"
fi

prepare_one() {
  local name="$1" code=0
  shift
  "$@" 2>&1 | tee "$state/$name.log" || code=$?
  printf '%s\n' "$code" > "$state/$name.exit"
  return "$code"
}

background() {
  local name="$1"
  shift
  rm -f "$state/$name.exit" "$state/$name.process"
  : > "$state/$name.log"
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
  if [ "$conformance_part" = 1 ]; then
    if [ "$1" = start ]; then
      background postgres bash "$script_directory/ci-postgres-toolchain.sh" install
    else
      prepare_one postgres bash "$script_directory/ci-postgres-toolchain.sh" install
    fi
  fi
  if [ "$integration_database" = 1 ]; then
    if [ "$1" = start ]; then
      background db node "$script_directory/ci-go-prerequisites.mjs" database-start
    else
      prepare_one db node "$script_directory/ci-go-prerequisites.mjs" database-start
    fi
  fi
  if [ "$scripts_database" = 1 ]; then
    if [ "$1" = start ]; then
      background scripts-db node "$script_directory/ci-go-prerequisites.mjs" scripts-database-start
    else
      prepare_one scripts-db node "$script_directory/ci-go-prerequisites.mjs" scripts-database-start
    fi
  fi
  exit 0
fi

ready() {
  local name="$1" descriptor line='' complete=0
  [ "${CI_PREREQUISITES_UNTRACKED:-0}" != 1 ] || return 0
  [ -f "$state/$name.log" ] || { echo "Prerequisite $name startup status is missing" >&2; return 1; }
  exec {descriptor}< "$state/$name.log" || return $?
  while [ "$complete" = 0 ]; do
    if [ -f "$state/$name.exit" ]; then complete=1; fi
    # The descriptor advances once through real output; a silent installer cannot reset the watchdog.
    while IFS= read -r -u "$descriptor" line || [ -n "$line" ]; do printf '%s\n' "$line"; done
    if [ "$complete" = 0 ]; then sleep 0.5; fi
  done
  exec {descriptor}<&-
  [ "$(cat "$state/$name.exit")" = 0 ] || { echo "$name failed to start" >&2; return 1; }
}

ensure_preparation() {
  local name="$1"; shift
  [ "${CI_PREREQUISITES_UNTRACKED:-0}" != 1 ] || return 0
  if [ ! -f "$state/$name.log" ]; then prepare_one "$name" "$@" || return $?; fi
  ready "$name"
}

# A root action may follow the host's scope-free integration setup, or run without a start phase.
if [ "$go_part" = 1 ]; then
  ensure_preparation go bash "$script_directory/ci-go-toolchain.sh" install
  ci_go_verify
fi
if [ "$conformance_part" = 1 ]; then ensure_preparation postgres bash "$script_directory/ci-postgres-toolchain.sh" install; fi
if [ "$integration_database" = 1 ]; then ensure_preparation db node "$script_directory/ci-go-prerequisites.mjs" database-start; fi
if [ "$scripts_database" = 1 ]; then ensure_preparation scripts-db node "$script_directory/ci-go-prerequisites.mjs" scripts-database-start; fi

reports=()
duration_reports=()
suite_code=0
run_check() {
  local code=0
  "$@" || code=$?
  if [ "$suite_code" = 0 ]; then suite_code="$code"; fi
}

build_contracts() {
  if [ "$affected" = 1 ]; then
    node scripts/ci-contracts.mjs affected "$PWD" "${FOREMAN_CODE_CI_CONTRACTS_CACHE:-$state/contracts-cache}"
    return $?
  fi
  if [ -n "${FOREMAN_CODE_CI_CONTRACTS_CACHE:-}" ] && node scripts/ci-contracts.mjs ready "$PWD"; then return 0; fi
  pnpm --filter @foreman-code/contracts build
}

retained_check() {
  local kind="$1" code=0 status
  build_contracts || return $?
  pnpm -r --no-bail --filter @foreman-code/contracts --filter @foreman-code/web "$kind" || code=$?
  if [ -f conformance/package.json ]; then
    case "$kind" in typecheck|lint)
      pnpm --dir conformance "$kind" || { status=$?; if [ "$code" = 0 ]; then code="$status"; fi; } ;;
    esac
  fi
  return "$code"
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

script_tests() (
  local report="$1" database_environment
  ready scripts-db || return $?
  database_environment="$(node scripts/ci-go-prerequisites.mjs scripts-database-env)" || return $?
  eval "$database_environment" || return $?
  node_tests "$report" 'scripts/**/*.test.mjs'
)

unit_other() {
  local code=0 status directory="$state/unit-other"
  mkdir -p "$directory"
  rm -f "$directory/contracts.json" "$directory/scripts.json" "$directory/conformance.json"
  build_contracts || return $?
  reports+=("$directory/contracts.json" "$directory/scripts.json")
  pnpm --filter @foreman-code/contracts test --reporter=default --reporter=json \
    "--outputFile.json=$directory/contracts.json" || code=$?
  if [ -f conformance/package.json ]; then
    reports+=("$directory/conformance.json")
    pnpm --dir conformance test --reporter=default --reporter=json \
      "--reporter=$script_directory/ci-progress-reporter.mjs" "--outputFile.json=$directory/conformance.json" \
      || { status=$?; if [ "$code" = 0 ]; then code="$status"; fi; }
  fi
  script_tests "$directory/scripts.json" || { status=$?; if [ "$code" = 0 ]; then code="$status"; fi; }
  return "$code"
}

affected_retained() (
  local kind="${SUITE%%-*}" report="$state/affected-retained.vitest.json" durations="$state/affected-retained.durations.json"
  if [ "$scripts_database" = 1 ]; then
    local database_environment
    database_environment="$(node scripts/ci-go-prerequisites.mjs scripts-database-env)" || return $?
    eval "$database_environment" || return $?
  fi
  CI_AFFECTED_VITEST_OUTPUT="$report" TEST_RESULTS_OUTPUT="$state/affected-retained.results.json" DURATIONS_OUTPUT="$durations" \
    node --input-type=module -e '
      import { executeAffected } from "./scripts/ci-affected-run.mjs"
      process.exitCode = await executeAffected(process.argv[1], process.argv[2])
    ' "$kind" "$CI_AFFECTED_SELECTION_FILE"
)

affected_checks() {
  local kind="${SUITE%%-*}" comparison=0
  # The helper returns before touching contracts metadata for a Go-only request.
  build_contracts || return $?
  if [ "$go_selected" = 1 ]; then
    case "$kind" in
      typecheck) run_check ci_go_typecheck ;;
      lint) run_check ci_go_lint ;;
      build) run_check ci_go_build ;;
      unit) run_check ci_go_test unit ;;
      integration) run_check ci_go_integration_test ;;
    esac
  fi
  if [ "$conformance_part" = 1 ]; then
    # Setup failures remain setup failures and never qualify a negative native proof.
    ci_go_conformance_binary && ci_conformance_identity && ci_conformance_postgres || return $?
    run_check ci_conformance_test go "$CI_AFFECTED_SELECTION_FILE"
    ci_conformance_changed "$CI_AFFECTED_SELECTION_FILE" || comparison=$?
    if [ "$comparison" -gt 1 ]; then return "$comparison"; fi
    if [ "$comparison" = 0 ]; then run_check ci_conformance_test ts "$CI_AFFECTED_SELECTION_FILE"; fi
  fi
  if [ "$retained_part" = 1 ]; then
    case "$kind" in unit|integration) reports+=("$state/affected-retained.vitest.json") ;; esac
    run_check affected_retained
    if [ -f "$state/affected-retained.durations.json" ]; then duration_reports+=("$state/affected-retained.durations.json"); fi
  fi
}

if [ "$affected" = 1 ] && [ "${SUITE:-}" != install ]; then
  run_check affected_checks
else
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
    run_check ci_go_integration_test
    run_check build_contracts
    run_check ci_go_conformance_binary
    run_check ci_conformance_identity
    run_check ci_conformance_postgres
    run_check ci_conformance_test go
    if ci_conformance_changed; then run_check ci_conformance_test ts; fi ;;
  *) echo "Unknown suite ${SUITE:-}" >&2; exit 2 ;;
esac
fi

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
