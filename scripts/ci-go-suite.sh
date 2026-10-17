#!/bin/bash
# Sourced by ci-suite.sh; one complete backend module is checked for every Go part.

ci_go_check_module() {
  [ -f backend/go.mod ] || { echo 'The required backend/go.mod is missing.' >&2; return 1; }
  ci_go_verify || return $?
  node scripts/ci-go-prerequisites.mjs native
}

ci_go_typecheck() {
  ci_go_check_module || return $?
  printf 'Running Go %s: build ./... and vet ./... in backend/\n' "$ci_go_version"
  (cd backend && go build ./... && go vet ./...)
}

ci_go_build() {
  ci_go_check_module || return $?
  printf 'Running Go %s: build ./... in backend/\n' "$ci_go_version"
  (cd backend && go build ./...)
}

ci_go_lint() {
  ci_go_check_module || return $?
  ci_staticcheck_verify || { echo 'Pinned Staticcheck is missing; run ci-suite.sh start or prepare.' >&2; return 1; }
  local unformatted
  unformatted="$(cd backend && gofmt -l .)" || return $?
  if [ -n "$unformatted" ]; then
    printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
    return 1
  fi
  printf 'Running Staticcheck %s for ordinary and integration builds in backend/\n' "$ci_staticcheck_version"
  (cd backend && staticcheck ./... && staticcheck -tags integration ./...)
}

ci_go_test() {
  local kind="$1" code=0 module
  ci_go_check_module || return $?
  module="$(cd backend && go list -m)" || return $?
  local report="$state/go-$kind.vitest.json" durations="$state/go-$kind.durations.json"
  local flags=(-json -count=1)
  if [ "$kind" = integration ]; then flags+=(-tags integration); fi
  rm -f "$report" "$durations"
  reports+=("$report")
  # Conversion is unconditional: go test succeeds with no test files, which is a CI failure here.
  (cd backend && go test "${flags[@]}" ./...) \
    | node scripts/ci-go-test-results.mjs --module "$module" --output "$report" --durations "$durations" || code=$?
  if [ -f "$durations" ]; then duration_reports+=("$durations"); fi
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
