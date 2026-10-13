#!/bin/bash
# Runs one CI suite on a fresh cloud machine (GitHub Actions or CircleCI).
#   scripts/ci-suite.sh start  — before `pnpm install`: starts PostgreSQL and the harness CLIs in the background
#   scripts/ci-suite.sh        — after `pnpm install`: waits for them, then runs the suite
#   scripts/ci-suite.sh prepare — after `pnpm install` on a build computer: prepares prerequisites synchronously
# SUITE: install, typecheck, lint, unit, build or integration, or one part of a check so the parts run on separate
# machines: unit-api, unit-web, unit-web-heavy, unit-other, lint-api, lint-other, typecheck-api, typecheck-other,
# build-api, build-other. For unit-api and unit-web, SLICE is
# a duration-balanced shard such as 2/3 (scripts/ci-unit-files.mjs). SLICE: an integration partition's file indexes
# (scripts/ci-files.mjs); empty runs every file. DURATIONS_OUTPUT: where measured file durations go.
# TEST_RESULTS_OUTPUT: where structured test results go for unit and integration (scripts/ci-test-results.mjs).
# Host CI uses this hook for named parts; ci-files.mjs opts into integration partitions.
set -euo pipefail
# Only test suites report per-test progress; typecheck, lint and build can stay silent for minutes.
if [ "${CI_WATCHDOG_ACTIVE:-}" != 1 ] && [ -n "${CI_EXPECTED_DURATION_MS:-}" ] && [ -z "${1:-}" ]; then
  case "${SUITE:-}" in unit|unit-*|integration) exec node "$(dirname "$0")/ci-watchdog.mjs" -- bash "$0" ;; esac
fi
# Test commands never inherit where this run's results go: a nested CI fixture would write over them.
test_results="${TEST_RESULTS_OUTPUT:-}"
unset TEST_RESULTS_OUTPUT
state="${CI_STATE:-${TMPDIR:-/tmp}/foreman-ci-state}"

if [ "${CI_HOST_RUNNER:-0}" = 1 ]; then
  pnpm() { corepack pnpm "$@"; }
fi

if [ "${1:-}" = start ] || [ "${1:-}" = prepare ]; then
  case "$SUITE" in unit|unit-*|integration) ;; *) exit 0 ;; esac
  clis="npm install --global --silent --before=$(date -u -d '-2 days' +%Y-%m-%dT%H:%M:%SZ) @openai/codex @anthropic-ai/claude-code"
  if [ "$1" = prepare ]; then
    corepack pnpm db:up
    case "$SUITE" in unit|unit-api|integration)
      if ! command -v codex >/dev/null || ! command -v claude >/dev/null; then
        bash -c "$clis"
      fi ;;
    esac
    exit 0
  fi
  mkdir -p "$state"
  background() { setsid nohup bash -c "$2 > '$state/$1.log' 2>&1; echo \$? > '$state/$1.exit'" >/dev/null 2>&1 & }
  # scripts/test-db.mjs needs only Node, so the database starts while packages install.
  background db 'node scripts/test-db.mjs up'
  # Harness tests check the installed Codex and Claude CLIs, as on our build computers; same 48-hour package age rule.
  case "$SUITE" in unit|unit-api|integration) background clis "$clis" ;; esac
  exit 0
fi

# Native process tests need a delegated cgroup, as a systemd user service gets on our build computers.
delegate_cgroup() {
  # Host CI already runs inside a delegated systemd unit.
  [ "${CI_HOST_RUNNER:-0}" != 1 ] || return 0
  local cgroup=/sys/fs/cgroup/foreman-ci
  sudo mkdir -p "$cgroup" && sudo chown -R "$(id -u):$(id -g)" "$cgroup"
  echo $$ | sudo tee "$cgroup/cgroup.procs" >/dev/null
}

ready() {
  [ -d "$state" ] || return 0
  [ -f "$state/$1.log" ] || return 0
  until [ -f "$state/$1.exit" ]; do sleep 0.5; done
  [ "$(cat "$state/$1.exit")" = 0 ] || { cat "$state/$1.log"; echo "$1 failed to start"; exit 1; }
}

record_tests() {
  [ -n "$test_results" ] || return 0
  node scripts/ci-test-results.mjs "$test_results" "$@" || echo 'Test results were not recorded.'
}

unit_slice() {
  local suite="$1" package="$2" code=0
  local output
  output="$(realpath -m "${DURATIONS_OUTPUT:-$state/durations.json}")"
  mkdir -p "$state" "$(dirname "$output")"
  node scripts/ci-unit-files.mjs select "$suite" "${SLICE:-}" > "$state/unit-files"
  local files=() reporters=(--reporter=default --reporter=json "--reporter=$(realpath scripts/ci-progress-reporter.mjs)" "--outputFile.json=$output.vitest.json")
  mapfile -d '' -t files < "$state/unit-files"
  rm -f "$output" "$output.vitest.json"
  if [ "$suite" = unit-api ]; then
    (cd "$package" && pnpm test "${files[@]}" "${reporters[@]}") || code=$?
  else
    (cd "$package" && FOREMAN_WEB_TEST_PHASE=fast pnpm exec vitest run "${files[@]}" "${reporters[@]}") || code=$?
  fi
  if [ -f "$output.vitest.json" ]; then
    node scripts/ci-unit-files.mjs record "$suite" "$output.vitest.json" "$output"
  fi
  record_tests "$output.vitest.json"
  return "$code"
}

node_tests() {
  local report="$1"; shift
  pnpm exec node --test --test-reporter=spec --test-reporter-destination=stdout \
    "--test-reporter=$node_reporter" "--test-reporter-destination=$report" "$@"
}

unit_other() {
  local code=0 status=0
  local reports node_reporter
  reports="$(realpath -m "$state/unit-other")"
  node_reporter="$(realpath scripts/ci-node-test-reporter.mjs)"
  mkdir -p "$reports"
  rm -f "$reports/contracts.json" "$reports/worker.json" "$reports/scripts.json"
  pnpm --filter @foreman-code/contracts build || return $?
  pnpm --filter @foreman-code/contracts test --reporter=default --reporter=json \
    "--outputFile.json=$reports/contracts.json" || code=$?
  (cd apps/worker && node_tests "$reports/worker.json" test/*.test.mjs) || status=$?
  if [ "$code" = 0 ]; then code="$status"; fi
  local script_files=()
  mapfile -t script_files < <(node --input-type=module -e '
    import { readFileSync } from "node:fs"
    const command = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:scripts"]
    console.log(command.split(/\s+/).filter(value => /^scripts\/.*\.test\.mjs$/.test(value)).join("\n"))
  ')
  status=0
  node_tests "$reports/scripts.json" "${script_files[@]}" || status=$?
  if [ "$code" = 0 ]; then code="$status"; fi
  record_tests "$reports/contracts.json" "$reports/worker.json" "$reports/scripts.json"
  return "$code"
}

scope="${SCOPE:-affected}"
selected_list=''
if [ "$scope" = affected ] && [ -z "${SELECTED_FILES:-}" ] && { [ "$SUITE" != integration ] || [ -z "${SLICE:-}" ]; }; then
  if [ ! -f scripts/ci-affected.mjs ]; then
    echo 'Running full suite: The repository has no affected selector.'
    scope=full
  else
    branch="${DEFAULT_BRANCH:-main}"
    default_ref="refs/remotes/origin/$branch"
    if [ -n "${BASE_COMMIT:-}" ]; then
      if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
        git fetch --quiet --no-tags --depth=2 origin "$(git rev-parse HEAD)"
        git fetch --quiet --no-tags --depth=1 origin "$BASE_COMMIT"
      fi
    else
      if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
        git fetch --quiet --no-tags --unshallow origin "+refs/heads/$branch:$default_ref"
      else
        git fetch --quiet --no-tags origin "+refs/heads/$branch:$default_ref"
      fi
    fi
    mkdir -p "$state"
    selected_list="$state/selected-files.json"
    scope="$(node scripts/ci-selection.mjs "$SUITE" "$default_ref" "${CI_PARTITION:-}" "$selected_list")"
    if [ "$scope" = full ] && { [ "$SUITE" != integration ] || [ -z "${CI_PARTITION:-}" ]; }; then
      selected_list=''
    fi
  fi
fi

# A full partitioned run whose file list does not fit a provider parameter computes its own partition from the
# commit's durations; every partition uses the same inputs, so together they cover each file exactly once.
if [ "$scope" = full ] && [ "$SUITE" = integration ] && [ -z "${SLICE:-}" ] && [ -n "${CI_PARTITION:-}" ] && [ -z "$selected_list" ]; then
  mkdir -p "$state"
  selected_list="$state/selected-files.json"
  node --input-type=module -e '
    import { readFileSync, writeFileSync, existsSync } from "node:fs"
    import { integrationPartition } from "./packages/contracts/src/ciPartition.mjs"
    import { integrationFileList } from "./scripts/ci-files.mjs"
    const durations = existsSync("scripts/integration-durations.json") ? JSON.parse(readFileSync("scripts/integration-durations.json", "utf8")) : {}
    const partition = JSON.parse(process.env.CI_PARTITION)
    writeFileSync(process.argv[1], JSON.stringify(integrationPartition(integrationFileList(process.cwd()), durations, partition)))
  ' "$selected_list"
fi

if [ "$scope" = affected ] && [ "$SUITE" != integration ]; then
  case "$SUITE" in
    unit|unit-api) ready db; ready clis; delegate_cgroup ;;
    unit-web|unit-web-heavy|unit-other) ready db ;;
    lint|lint-api|lint-other|typecheck|typecheck-api|typecheck-other) ;;
    *) echo "Unsupported affected suite $SUITE"; exit 2 ;;
  esac
  if [ -n "$selected_list" ]; then
    TEST_RESULTS_OUTPUT="$test_results" node scripts/ci-affected-run.mjs "${SUITE%%-*}" --files-from "$selected_list"
  else
    TEST_RESULTS_OUTPUT="$test_results" node scripts/ci-affected-run.mjs "${SUITE%%-*}" --indexes "${SELECTED_FILES:-}"
  fi
  exit $?
fi

case "$SUITE" in
  install) ;;
  unit) ready db; ready clis; delegate_cgroup; pnpm test ;;
  unit-api) ready db; ready clis; delegate_cgroup; pnpm --filter @foreman-code/contracts build
    unit_slice unit-api apps/api ;;
  unit-web) ready db; pnpm --filter @foreman-code/contracts build
    unit_slice unit-web apps/web ;;
  # SLICE i/n splits the heavy phase across machines; the run-graph smoke runs once, in the first shard.
  unit-web-heavy) ready db; pnpm --filter @foreman-code/contracts build
    case "${SLICE:-1/1}" in 1/*) pnpm --filter @foreman-code/web test:run-graph-smoke ;; esac
    mkdir -p "$state"; heavy_report="$(realpath -m "$state/unit-web-heavy.vitest.json")"; progress_reporter="$PWD/scripts/ci-progress-reporter.mjs"; code=0
    (cd apps/web && FOREMAN_WEB_TEST_PHASE=heavy pnpm exec vitest run ${SLICE:+--shard=$SLICE} \
      --reporter=default --reporter=json "--reporter=$progress_reporter" "--outputFile.json=$heavy_report") || code=$?
    record_tests "$heavy_report"; exit "$code" ;;
  unit-other) ready db; unit_other ;;
  lint-api) pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/api lint ;;
  lint-other) pnpm --filter @foreman-code/contracts build \
    && pnpm -r --no-bail --filter '!@foreman-code/api' --if-present lint ;;
  typecheck-api) pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/api typecheck ;;
  typecheck-other) pnpm --filter @foreman-code/contracts build \
    && pnpm -r --filter '!@foreman-code/api' --if-present typecheck ;;
  build-api) pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/api build ;;
  build-other) pnpm -r --filter '!@foreman-code/api' --if-present build ;;
  typecheck|lint|build) pnpm "$SUITE" ;;
  integration)
    if [ "${CI_USER_SYSTEMD:-0}" = 1 ] && [ "${CI_HOST_RUNNER:-0}" != 1 ]; then
      source scripts/ci-user-systemd.sh
    fi
    ready db; ready clis
    export FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT="$DURATIONS_OUTPUT"
    if [ -n "$test_results" ]; then export FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT="$test_results"; fi
    delegate_cgroup
    if [ -n "$selected_list" ]; then
      mapfile -d '' -t files < <(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).map(file => file + "\0").join(""))' "$selected_list")
      if [ "${#files[@]}" = 0 ]; then echo 'No affected files for this suite part.'; exit 0; fi
      pnpm test:integration --files "${files[@]}"
    else
      FILES="$(node scripts/ci-files.mjs "${SLICE:-}")"
      # shellcheck disable=SC2086 # the partition's files are separate arguments
      pnpm test:integration ${SLICE:+--files $FILES}
    fi ;;
  *) echo "Unknown suite $SUITE"; exit 2 ;;
esac
