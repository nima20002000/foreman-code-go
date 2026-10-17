#!/bin/bash
# Sourced by ci-suite.sh. Preserve the actual Q-CONF reports and evaluate the CI gate separately.

ci_conformance_identity() {
  conformance_commit=''
  conformance_commit_source=git
  if [ "${CONFORMANCE_COMMIT_SHA+x}" = x ]; then
    conformance_commit="$CONFORMANCE_COMMIT_SHA"
    conformance_commit_source=environment
  else
    conformance_commit="$(git rev-parse HEAD)" || return $?
  fi
}

ci_conformance_postgres() {
  ready postgres || return $?
  ci_postgres_verify
}

ci_conformance_changed() {
  local reference=refs/remotes/origin/main code=0
  # BASE_COMMIT can be an arbitrary CI selection base; only fork main decides the TS oracle check.
  if ! git fetch --quiet --no-tags --depth=1 origin "+refs/heads/main:$reference"; then
    echo 'Fork main is unavailable; requiring the TS conformance target.' >&2
    return 0
  fi
  git diff --quiet "$reference" HEAD -- conformance/ || code=$?
  if [ "$code" = 0 ]; then return 1; fi
  if [ "$code" != 1 ]; then echo 'Conformance comparison failed; requiring the TS target.' >&2; fi
  return 0
}

ci_conformance_test() {
  local target="$1" directory="$state/conformance"
  local inventory_code=0 launcher_code=0 copy_code=0 normalizer_code=0 gate_code=0
  local input="$directory/$target.json" inventory="$directory/$target.inventory.json"
  local report="$directory/$target.vitest.json" durations="$directory/$target.durations.json"
  local verdict="$directory/$target.full-verdict.json" gate="$directory/$target.gate.json"
  local events="$directory/$target.jsonl" errors="$directory/$target.stderr.log"
  local statuses=() gate_arguments=() main_input=''
  [ -f conformance/package.json ] || { echo 'The required conformance launcher is missing.' >&2; return 1; }
  mkdir -p "$directory" || return $?
  rm -f "$input" "$inventory" "$report" "$durations" "$verdict" "$gate" "$events" "$errors" || return $?
  reports+=("$report")

  CONFORMANCE_TARGET="$target" pnpm --silent --dir conformance run conformance --list > "$inventory" || inventory_code=$?
  (
    # Q-CONF initializes its own cluster per scenario; it must never reuse the Go integration database.
    unset DATABASE_URL TEST_DATABASE_URL FOREMAN_CODE_CI_TEST_ADMIN_URL
    unset GRAPHQL_DATABASE_URL GRAPHQL_TEST_DATABASE_URL GRAPHQL_CI_TEST_ADMIN_URL
    unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE
    export CONFORMANCE_TARGET="$target" CONFORMANCE_RESULTS_FILE="$input"
    export CONFORMANCE_GO_BINARY="$state/bin/foreman"
    pnpm --silent --dir conformance run conformance
  ) 2> "$errors" | tee "$events"
  statuses=("${PIPESTATUS[@]}")
  launcher_code="${statuses[0]}"
  copy_code="${statuses[1]}"
  cat "$errors" >&2 || { if [ "$copy_code" = 0 ]; then copy_code=1; fi; }

  node scripts/ci-conformance-results.mjs --input "$input" --inventory "$inventory" --output "$report" \
    --target "$target" --durations "$durations" --commit "$conformance_commit" \
    --commit-source "$conformance_commit_source" --verdict-output "$verdict" || normalizer_code=$?
  if [ -f "$durations" ]; then duration_reports+=("$durations"); fi

  gate_arguments=(--target "$target" --input "$input" --inventory "$inventory" --output "$gate"
    --commit "$conformance_commit" --commit-source "$conformance_commit_source" --launcher-exit "$launcher_code")
  case "$target" in
    go) main_input="${CONFORMANCE_MAIN_GO_RESULTS_FILE:-}" ;;
    ts) main_input="${CONFORMANCE_MAIN_TS_RESULTS_FILE:-}" ;;
  esac
  if [ -n "$main_input" ]; then gate_arguments+=(--main-input "$main_input" --main-commit "${CONFORMANCE_MAIN_COMMIT_SHA:-}"); fi
  node scripts/ci-conformance-gate.mjs "${gate_arguments[@]}" || gate_code=$?

  if [ "$inventory_code" != 0 ]; then return "$inventory_code"; fi
  if [ "$copy_code" != 0 ]; then return "$copy_code"; fi
  # Exit 1 denotes a valid full-conformance failure. Only the distinct gate may accept that incremental result.
  if [ "$normalizer_code" != 0 ] && [ "$normalizer_code" != 1 ]; then return "$normalizer_code"; fi
  if [ ! -f "$report" ] || [ ! -f "$durations" ] || [ ! -f "$verdict" ] || [ ! -f "$gate" ]; then
    echo 'Conformance reporting did not publish its complete validated outputs.' >&2
    return 2
  fi
  return "$gate_code"
}
