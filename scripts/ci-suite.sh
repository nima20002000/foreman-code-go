#!/bin/bash
# Runs one CI suite on a fresh cloud machine (GitHub Actions or CircleCI) after `pnpm install`.
# SUITE: install, typecheck, lint, unit, build or integration. SLICE: an integration partition's file indexes
# (scripts/ci-files.mjs); empty runs every file.
# DURATIONS_OUTPUT: where the integration runner writes the file durations it measured.
set -euo pipefail
case "$SUITE" in
  install) ;;
  unit) pnpm db:up && pnpm test ;;
  typecheck|lint|build) pnpm "$SUITE" ;;
  integration)
    # Harness tests check the installed Codex and Claude CLIs, as on our build computers.
    # Same 48-hour package age rule as the repository install.
    npm install --global --silent --before="$(date -u -d '-2 days' +%Y-%m-%dT%H:%M:%SZ)" @openai/codex @anthropic-ai/claude-code &
    pnpm db:up
    wait
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
