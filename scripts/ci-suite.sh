#!/bin/bash
# Runs one CI suite on a fresh cloud machine (GitHub Actions or CircleCI).
#   scripts/ci-suite.sh start  — before `pnpm install`: starts PostgreSQL and the harness CLIs in the background
#   scripts/ci-suite.sh        — after `pnpm install`: waits for them, then runs the suite
# SUITE: install, typecheck, lint, unit, build or integration, or one part of a check so the parts run on separate
# machines: unit-api, unit-web, unit-web-heavy, unit-other, lint-api, lint-other. For unit-api and unit-web, SLICE is
# a Vitest shard such as 2/3. SLICE: an integration partition's file indexes
# (scripts/ci-files.mjs); empty runs every file. DURATIONS_OUTPUT: where measured file durations go.
set -euo pipefail
state="${CI_STATE:-${TMPDIR:-/tmp}/foreman-ci-state}"

if [ "${1:-}" = start ]; then
  mkdir -p "$state"
  background() { setsid nohup bash -c "$2 > '$state/$1.log' 2>&1; echo \$? > '$state/$1.exit'" >/dev/null 2>&1 & }
  # scripts/test-db.mjs needs only Node, so the database starts while packages install.
  case "$SUITE" in unit|unit-api|integration) background db 'node scripts/test-db.mjs up' ;; esac
  # Harness tests check the installed Codex and Claude CLIs, as on our build computers; same 48-hour package age rule.
  [ "$SUITE" = integration ] && background clis "npm install --global --silent --before=$(date -u -d '-2 days' +%Y-%m-%dT%H:%M:%SZ) @openai/codex @anthropic-ai/claude-code"
  exit 0
fi

ready() {
  [ -d "$state" ] || return 0
  [ -f "$state/$1.log" ] || return 0
  until [ -f "$state/$1.exit" ]; do sleep 0.5; done
  [ "$(cat "$state/$1.exit")" = 0 ] || { cat "$state/$1.log"; echo "$1 failed to start"; exit 1; }
}

case "$SUITE" in
  install) ;;
  unit) ready db; pnpm test ;;
  unit-api) ready db; pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/api test ${SLICE:+--shard=$SLICE} ;;
  unit-web) pnpm --filter @foreman-code/contracts build
    (cd apps/web && FOREMAN_WEB_TEST_PHASE=fast pnpm exec vitest run ${SLICE:+--shard=$SLICE}) ;;
  unit-web-heavy) pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/web test:run-graph-smoke
    (cd apps/web && FOREMAN_WEB_TEST_PHASE=heavy pnpm exec vitest run) ;;
  unit-other) pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/contracts --filter @foreman-code/worker test \
    && pnpm test:scripts ;;
  lint-api) pnpm --filter @foreman-code/contracts build && pnpm --filter @foreman-code/api lint ;;
  lint-other) pnpm --filter @foreman-code/contracts build \
    && pnpm -r --no-bail --filter '!@foreman-code/api' --if-present lint ;;
  typecheck|lint|build) pnpm "$SUITE" ;;
  integration)
    ready db; ready clis
    export FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT="$DURATIONS_OUTPUT"
    # Native process tests need a delegated cgroup, as a systemd user service gets on our build computers.
    cgroup=/sys/fs/cgroup/foreman-ci
    sudo mkdir -p "$cgroup" && sudo chown -R "$(id -u):$(id -g)" "$cgroup"
    echo $$ | sudo tee "$cgroup/cgroup.procs" >/dev/null
    FILES="$(node scripts/ci-files.mjs "${SLICE:-}")"
    # shellcheck disable=SC2086 # the partition's files are separate arguments
    pnpm test:integration ${SLICE:+--files $FILES} ;;
  *) echo "Unknown suite $SUITE"; exit 2 ;;
esac
