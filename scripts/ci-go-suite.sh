#!/bin/bash
# Sourced by ci-suite.sh. Only explicit release mode may select the whole module.

ci_go_check_module() {
  [ -f backend/go.mod ] || { echo 'The required backend/go.mod is missing.' >&2; return 1; }
  ci_go_verify || return $?
  node scripts/ci-go-prerequisites.mjs native
}

ci_go_scope() {
  ci_go_packages=()
  if [ "${SCOPE:-affected}" = full ]; then
    [ "${FOREMAN_CODE_CI_RELEASE:-}" = 1 ] || { echo 'Full Go scope requires explicit release mode.' >&2; return 2; }
    ci_go_packages=(./...)
    return 0
  fi
  [ -n "${CI_AFFECTED_SELECTION_FILE:-}" ] || { echo 'Go scope requires an exact affected selection.' >&2; return 2; }
  mkdir -p "$state/go" || return $?
  node scripts/ci-affected-scope.mjs go-packages "$CI_AFFECTED_SELECTION_FILE" > "$state/go/package-arguments" || return $?
  mapfile -d '' -t ci_go_packages < "$state/go/package-arguments" || return $?
  [ "${#ci_go_packages[@]}" -gt 0 ] || { echo 'The affected request selected zero Go packages.' >&2; return 2; }
}

ci_go_typecheck() {
  ci_go_scope && ci_go_check_module || return $?
  printf 'Running Go %s: build and vet of %s selected package(s) in backend/\n' "$ci_go_version" "${#ci_go_packages[@]}"
  (cd backend && go build "${ci_go_packages[@]}" && go vet "${ci_go_packages[@]}")
}

ci_go_build() {
  ci_go_scope && ci_go_check_module || return $?
  printf 'Running Go %s: build of %s selected package(s) in backend/\n' "$ci_go_version" "${#ci_go_packages[@]}"
  (cd backend && go build "${ci_go_packages[@]}")
}

ci_go_lint() {
  ci_go_scope && ci_go_check_module || return $?
  ci_staticcheck_verify || { echo 'Pinned Staticcheck is missing; run ci-suite.sh start or prepare.' >&2; return 1; }
  local unformatted files=()
  if [ "${SCOPE:-affected}" = full ]; then
    unformatted="$(cd backend && gofmt -l .)" || return $?
  else
    node scripts/ci-affected-scope.mjs go-files "$CI_AFFECTED_SELECTION_FILE" > "$state/go/file-arguments" || return $?
    mapfile -d '' -t files < "$state/go/file-arguments" || return $?
    [ "${#files[@]}" -gt 0 ] || { echo 'The affected lint request selected zero Go files.' >&2; return 2; }
    unformatted="$(gofmt -l "${files[@]}")" || return $?
  fi
  if [ -n "$unformatted" ]; then
    printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
    return 1
  fi
  printf 'Running Staticcheck %s for the selected ordinary and integration package builds\n' "$ci_staticcheck_version"
  (cd backend && staticcheck "${ci_go_packages[@]}" && staticcheck -tags integration "${ci_go_packages[@]}")
}

ci_go_test_stream() {
  local kind="$1" code=0 status package roots
  local flags=(-json -count=1)
  if [ "$kind" = integration ]; then flags+=(-tags integration); fi
  if [ "${SCOPE:-affected}" = full ]; then
    (cd backend && go test "${flags[@]}" "${ci_go_packages[@]}") || code=$?
    printf '{"package":"./...","filter":null,"exit":%s}\n' "$code" > "$state/go/$kind.commands.jsonl" || return $?
    return "$code"
  fi
  for package in "${ci_go_packages[@]}"; do
    roots="$(node scripts/ci-affected-scope.mjs go-roots "$CI_AFFECTED_SELECTION_FILE" "$package")" || return $?
    status=0
    (cd backend && go test "${flags[@]}" -run "$roots" "$package") || status=$?
    printf '{"package":"%s","filter":"%s","exit":%s}\n' "$package" "$roots" "$status" \
      >> "$state/go/$kind.commands.jsonl" || return $?
    if [ "$code" = 0 ]; then code="$status"; fi
  done
  return "$code"
}

ci_go_test() {
  local kind="$1" code=0 module native_code=0 stderr_code=0 statuses=()
  case "$kind" in unit|integration) ;; *) echo 'Unsupported Go test kind.' >&2; return 2 ;; esac
  if [ -n "${CI_NATIVE_REPORTS_DIR:-}${CI_NATIVE_SELECTOR:-}" ]; then
    node scripts/ci-native-reports.mjs begin --kind "go-$kind" || return $?
  fi
  ci_go_scope && ci_go_check_module || return $?
  module="$(cd backend && go list -m)" || return $?
  local report="$state/go-$kind.vitest.json" durations="$state/go-$kind.durations.json"
  local raw="$state/go/$kind.jsonl" errors="$state/go/$kind.stderr.log"
  local selection="$state/go/$kind.selection.json" arguments=()
  mkdir -p "$state/go" || return $?
  rm -f "$report" "$durations" "$raw" "$errors" "$selection" "$state/go/$kind.commands.jsonl" || return $?
  reports+=("$report")
  if [ "${SCOPE:-affected}" != full ]; then
    node scripts/ci-affected-scope.mjs go-selection "$CI_AFFECTED_SELECTION_FILE" "$selection" || return $?
    arguments+=(--selection "$selection")
  fi
  # Retain exact events and always convert: Go itself succeeds when a selected filter has no cases.
  if ci_go_test_stream "$kind" 2> "$errors" | tee "$raw" \
    | node scripts/ci-go-test-results.mjs --module "$module" --output "$report" --durations "$durations" "${arguments[@]}"; then
    statuses=("${PIPESTATUS[@]}")
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  cat "$errors" >&2 || stderr_code=$?
  local status
  for status in "${statuses[@]}" "$stderr_code"; do if [ "$code" = 0 ]; then code="$status"; fi; done
  if [ -f "$durations" ]; then duration_reports+=("$durations"); fi
  if [ -n "${CI_NATIVE_REPORTS_DIR:-}${CI_NATIVE_SELECTOR:-}" ]; then
    node scripts/ci-native-reports.mjs finish --kind "go-$kind" --input "$report" --exit-code "$code" || native_code=$?
    if [ "$code" = 0 ] && [ "$native_code" != 0 ]; then code="$native_code"; fi
  fi
  printf '{"kind":"go-%s","nativeExit":%s,"captureExit":%s,"converterExit":%s,"stderrExit":%s,"publicationExit":%s,"actionExit":%s}\n' \
    "$kind" "${statuses[0]}" "${statuses[1]}" "${statuses[2]}" "$stderr_code" "$native_code" "$code" \
    > "$state/go/$kind.action-status.json" || return $?
  return "$code"
}

ci_go_integration_test() {
  local database_environment
  local DATABASE_URL TEST_DATABASE_URL FOREMAN_CODE_CI_TEST_ADMIN_URL
  ready db || return $?
  database_environment="$(node scripts/ci-go-prerequisites.mjs database-env)" || return $?
  eval "$database_environment" || return $?
  ci_go_test integration
}

ci_go_conformance_binary() {
  export CONFORMANCE_GO_BINARY="$state/bin/foreman"
  mkdir -p "$state/bin" || return $?
  rm -f "$CONFORMANCE_GO_BINARY" || return $?
  ci_go_check_module || return $?
  printf 'Building the Go conformance target from backend/cmd/foreman\n'
  (cd backend && go build -o "$CONFORMANCE_GO_BINARY" ./cmd/foreman)
}
