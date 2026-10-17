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
  local target="$1" code=0
  local input="$state/conformance-$target.json" report="$state/conformance-$target.vitest.json"
  local durations="$state/conformance-$target.durations.json"
  [ -f conformance/package.json ] || { echo 'The required conformance launcher is missing.' >&2; return 1; }
  rm -f "$input" "$report" "$durations"
  reports+=("$report")
  # Proposed Q-CONF interface; its owner must supply this package script and report contract.
  CONFORMANCE_TARGET="$target" CONFORMANCE_RESULTS_OUTPUT="$input" \
    pnpm --dir conformance run test:ci || code=$?
  node scripts/ci-conformance-results.mjs --input "$input" --output "$report" --target "$target" \
    --durations "$durations" || { if [ "$code" = 0 ]; then code=1; fi; }
  if [ -f "$durations" ]; then duration_reports+=("$durations"); fi
  return "$code"
}
