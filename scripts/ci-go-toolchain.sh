#!/bin/bash
# Sourced by ci-suite.sh. Every writable Go path lives under the CI cache prefix.

ci_go_environment() {
  local platform settings
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) platform=linux-amd64 ;;
    Linux/aarch64|Linux/arm64) platform=linux-arm64 ;;
    *) echo 'Go CI supports Linux amd64 and arm64 build computers.' >&2; return 1 ;;
  esac
  settings="$(node --input-type=module - "$(dirname "${BASH_SOURCE[0]}")/ci-go-versions.json" "$platform" <<'NODE'
import { readFileSync } from 'node:fs'
const pins = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const oldEnough = value => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) >= 48 * 3_600_000
if (!/^\d+\.\d+\.\d+$/.test(pins.go.version) || !/^v\d+\.\d+\.\d+$/.test(pins.staticcheck.version)
  || !oldEnough(pins.go.released) || !oldEnough(pins.staticcheck.released)) {
  throw new Error('Go and Staticcheck must use exact versions released at least 48 hours ago.')
}
const checksum = pins.go.sha256[process.argv[3]]
if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('The Go archive checksum is missing for this platform.')
console.log([pins.go.version, pins.staticcheck.version, checksum].join('\n'))
NODE
  )" || return $?
  local values=()
  mapfile -t values <<< "$settings"
  [ "${#values[@]}" = 3 ] || { echo 'Invalid Go toolchain configuration.' >&2; return 1; }
  ci_go_version="${values[0]}"
  ci_staticcheck_version="${values[1]}"
  ci_go_checksum="${values[2]}"
  ci_go_platform="$platform"
  export FOREMAN_CODE_CI_GO_CACHE="$(realpath -m "${FOREMAN_CODE_CI_GO_CACHE:-$HOME/.cache/foreman-go}")"
  export GOROOT="$FOREMAN_CODE_CI_GO_CACHE/toolchains/go$ci_go_version"
  export GOCACHE="$FOREMAN_CODE_CI_GO_CACHE/build"
  export GOMODCACHE="$FOREMAN_CODE_CI_GO_CACHE/modules"
  export GOPATH="$FOREMAN_CODE_CI_GO_CACHE/gopath"
  ci_staticcheck_directory="$FOREMAN_CODE_CI_GO_CACHE/tools/staticcheck-$ci_staticcheck_version/bin"
  export PATH="$GOROOT/bin:$ci_staticcheck_directory:$PATH"
  # Do not inherit a user Go workspace, compiler flags, or automatic toolchain upgrades.
  export GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly
  export GOOS=linux GOARCH="${platform#linux-}" CGO_ENABLED=1
}

ci_go_verify() {
  [ -x "$GOROOT/bin/go" ] || { echo 'Pinned Go is missing; run ci-suite.sh start or prepare.' >&2; return 1; }
  local version
  version="$("$GOROOT/bin/go" env GOVERSION)" || return $?
  [ "$version" = "go$ci_go_version" ] || { echo "Expected Go $ci_go_version; cached compiler reports $version." >&2; return 1; }
}

ci_staticcheck_verify() {
  [ -x "$ci_staticcheck_directory/staticcheck" ] || return 1
  local version
  version="$("$ci_staticcheck_directory/staticcheck" -version)" || return $?
  case "$version" in
    "staticcheck "*"(${ci_staticcheck_version#v})") return 0 ;;
    *) echo "Cached Staticcheck does not match $ci_staticcheck_version: $version" >&2; return 1 ;;
  esac
}

ci_go_install() (
  set -euo pipefail
  ci_go_environment
  mkdir -p "$FOREMAN_CODE_CI_GO_CACHE/toolchains" "$GOCACHE" "$GOMODCACHE"
  # Build-computer parts can prepare the same cache concurrently.
  exec 9> "$FOREMAN_CODE_CI_GO_CACHE/install.lock"
  flock 9
  local temporary
  temporary="$(mktemp -d "$FOREMAN_CODE_CI_GO_CACHE/install.XXXXXX")"
  trap 'rm -rf "$temporary"' EXIT
  if ! ci_go_verify; then
    local archive="$temporary/go.tar.gz"
    curl --fail --location --retry 3 --output "$archive" "https://go.dev/dl/go$ci_go_version.$ci_go_platform.tar.gz"
    printf '%s  %s\n' "$ci_go_checksum" "$archive" | sha256sum --check --status -
    tar --extract --gzip --no-same-owner --file "$archive" --directory "$temporary"
    rm -rf "$GOROOT"
    mv "$temporary/go" "$GOROOT"
  fi
  ci_go_verify
  case "${SUITE:-}" in lint|lint-api)
    if ! ci_staticcheck_verify; then
      GOBIN="$temporary/bin" go install "honnef.co/go/tools/cmd/staticcheck@$ci_staticcheck_version"
      mkdir -p "$(dirname "$ci_staticcheck_directory")"
      rm -rf "$ci_staticcheck_directory"
      mv "$temporary/bin" "$ci_staticcheck_directory"
    fi
    ci_staticcheck_verify ;;
  esac
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  case "${1:-}" in
    install) ci_go_install ;;
    verify) ci_go_environment; ci_go_verify ;;
    *) echo 'Usage: ci-go-toolchain.sh install|verify' >&2; exit 2 ;;
  esac
fi
