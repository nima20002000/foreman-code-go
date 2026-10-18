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
  local selection="${1:-${CI_AFFECTED_SELECTION_FILE:-}}" required=''
  if [ -n "$selection" ]; then
    required="$(node scripts/ci-affected-scope.mjs conformance-ts-required "$selection")" || return 2
    case "$required" in 1) return 0 ;; 0) return 1 ;; *) return 2 ;; esac
  fi
  if [ "${SCOPE:-}" != full ] || [ "${FOREMAN_CODE_CI_RELEASE:-}" != 1 ]; then
    echo 'Conformance comparison requires an explicit affected selection or release scope.' >&2
    return 2
  fi
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
  local target="$1" selection="${2:-${CI_AFFECTED_SELECTION_FILE:-}}" directory="$state/conformance"
  local inventory_code=0 launcher_code=0 copy_code=0 normalizer_code=0 gate_code=0
  local action_code=0 native_code=0 gate_mode="${CONFORMANCE_GATE:-incremental}"
  local input="$directory/$target.json" inventory="$directory/$target.inventory.json"
  local report="$directory/$target.vitest.json" durations="$directory/$target.durations.json"
  local verdict="$directory/$target.full-verdict.json" gate="$directory/$target.gate.json"
  local events="$directory/$target.jsonl" errors="$directory/$target.stderr.log"
  local inventory_errors="$directory/$target.inventory.stderr.log" status="$directory/$target.action-status.json"
  local selected_ids="$directory/$target.selection.json" selected_arguments="$directory/$target.selection-arguments"
  local statuses=() gate_arguments=() scenario_ids=() launcher_arguments=() main_input='' id='' selected_targets=''
  case "$target" in go|ts) ;; *) echo 'Conformance target must be go or ts.' >&2; return 2 ;; esac
  if [ -z "$selection" ] && { [ "${SCOPE:-}" != full ] || [ "${FOREMAN_CODE_CI_RELEASE:-}" != 1 ]; }; then
    echo 'Conformance execution requires exact affected scenario IDs or explicit release scope.' >&2
    return 2
  fi
  if [ -n "${CI_NATIVE_REPORTS_DIR:-}${CI_NATIVE_SELECTOR:-}" ]; then
    node scripts/ci-native-reports.mjs begin --kind "conformance-$target" || return $?
  fi
  [ -f conformance/package.json ] || { echo 'The required conformance launcher is missing.' >&2; return 1; }
  mkdir -p "$directory" || return $?
  rm -f "$input" "$inventory" "$report" "$durations" "$verdict" "$gate" "$events" "$errors" \
    "$inventory_errors" "$status" "$selected_ids" "$selected_arguments" || return $?
  if [ -n "$selection" ]; then
    node scripts/ci-affected-scope.mjs conformance-selection "$selection" "$selected_ids" > "$selected_arguments" || return $?
    selected_targets="$(node scripts/ci-affected-scope.mjs conformance-targets "$selection")" || return $?
    case " $selected_targets " in
      *" $target "*) ;;
      *) echo "The affected conformance request does not select the $target target." >&2; return 2 ;;
    esac
    mapfile -d '' -t scenario_ids < "$selected_arguments" || return $?
    if [ "${#scenario_ids[@]}" = 0 ]; then echo 'Zero requested conformance scenario IDs.' >&2; return 2; fi
    for id in "${scenario_ids[@]}"; do launcher_arguments+=(--scenario "$id"); done
    gate_mode=affected
  fi
  reports+=("$report")

  # The full inventory is metadata for validating the exact executed selection, not a full scenario run.
  CONFORMANCE_TARGET="$target" pnpm --silent --dir conformance run conformance --target "$target" --list \
    > "$inventory" 2> "$inventory_errors" || inventory_code=$?
  (
    # Q-CONF initializes its own cluster per scenario; it must never reuse the Go integration database.
    unset DATABASE_URL TEST_DATABASE_URL FOREMAN_CODE_CI_TEST_ADMIN_URL
    unset GRAPHQL_DATABASE_URL GRAPHQL_TEST_DATABASE_URL GRAPHQL_CI_TEST_ADMIN_URL
    unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE
    export CONFORMANCE_TARGET="$target" CONFORMANCE_RESULTS_FILE="$input"
    export CONFORMANCE_GO_BINARY="$state/bin/foreman"
    pnpm --silent --dir conformance run conformance --target "$target" "${launcher_arguments[@]}"
  ) 2> "$errors" | tee "$events"
  statuses=("${PIPESTATUS[@]}")
  launcher_code="${statuses[0]}"
  copy_code="${statuses[1]}"
  cat "$errors" >&2 || { if [ "$copy_code" = 0 ]; then copy_code=1; fi; }
  cat "$inventory_errors" >&2 || { if [ "$copy_code" = 0 ]; then copy_code=1; fi; }

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
  if [ -n "$selection" ]; then
    gate_arguments+=(--selection "$selected_ids")
  elif [ -n "$main_input" ]; then
    gate_arguments+=(--main-input "$main_input" --main-commit "${CONFORMANCE_MAIN_COMMIT_SHA:-}")
  fi
  CONFORMANCE_GATE="$gate_mode" node scripts/ci-conformance-gate.mjs "${gate_arguments[@]}" || gate_code=$?

  # Exit 1 denotes a valid full-conformance failure. Only the distinct policy gate may accept that result.
  if [ "$inventory_code" != 0 ]; then action_code="$inventory_code"
  elif [ "$copy_code" != 0 ]; then action_code="$copy_code"
  elif [ "$normalizer_code" != 0 ] && [ "$normalizer_code" != 1 ]; then action_code="$normalizer_code"
  elif [ ! -f "$report" ] || [ ! -f "$durations" ] || [ ! -f "$verdict" ] || [ ! -f "$gate" ]; then
    echo 'Conformance reporting did not publish its complete validated outputs.' >&2
    action_code=2
  else action_code="$gate_code"
  fi
  if [ -n "${CI_NATIVE_REPORTS_DIR:-}${CI_NATIVE_SELECTOR:-}" ]; then
    node scripts/ci-native-reports.mjs finish --kind "conformance-$target" --input "$report" \
      --exit-code "$action_code" || native_code=$?
    if [ "$action_code" = 0 ] && [ "$native_code" != 0 ]; then action_code="$native_code"; fi
  fi
  printf '{"target":"%s","inventoryExit":%s,"launcherExit":%s,"captureExit":%s,"normalizerExit":%s,"gateExit":%s,"publicationExit":%s,"actionExit":%s}\n' \
    "$target" "$inventory_code" "$launcher_code" "$copy_code" "$normalizer_code" "$gate_code" "$native_code" "$action_code" \
    > "$status" || return $?
  return "$action_code"
}
