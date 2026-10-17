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
  local root="${1:-$GOROOT}" version
  [ -x "$root/bin/go" ] || { echo 'Pinned Go is missing; run ci-suite.sh start or prepare.' >&2; return 1; }
  version="$(GOROOT="$root" GOTOOLCHAIN=local "$root/bin/go" env GOVERSION)" || return $?
  [ "$version" = "go$ci_go_version" ] || { echo "Expected Go $ci_go_version; compiler reports $version." >&2; return 1; }
}

ci_go_bootstrap_candidates() {
  local directory candidate resolved repository state
  repository="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")" || return $?
  state="$(realpath -m "${CI_STATE:-$PWD/.logs/ci}")" || return $?
  local directories=()
  IFS=: read -r -a directories <<< "$PATH"
  for directory in "${directories[@]}"; do
    [[ "$directory" = /* && -d "$directory" ]] || continue
    for candidate in "$directory/go" "$directory"/go[0-9]*; do
      [ -f "$candidate" ] && [ -x "$candidate" ] || continue
      if [ "${candidate##*/}" != go ] && ! [[ "${candidate##*/}" =~ ^go[0-9]+\.[0-9]+\.[0-9]+$ ]]; then continue; fi
      resolved="$(realpath "$candidate")" || return $?
      case "$resolved" in
        "$repository"/*|"$PWD"/*|"$FOREMAN_CODE_CI_GO_CACHE"/*|"$HOME"/*|"$state"/*) continue ;;
      esac
      printf '%s\n' "$resolved"
    done
  done
}

ci_go_module_cleanup() {
  local status="$1" bootstrap="$2" invocation="$3"
  if ! GOTOOLCHAIN=local GOMODCACHE="$invocation/modules" "$bootstrap" clean -modcache; then
    echo "Failed to clean the owned Go module cache; preserving $invocation." >&2
    exit 1
  fi
  if ! rm -rf "$invocation"; then
    echo "Failed to remove the cleaned Go download directory: $invocation." >&2
    exit 1
  fi
  exit "$status"
}

ci_go_stage_toolchain() {
  local source="$1" destination="$2"
  ci_go_verify "$source"
  mkdir "$destination"
  # Only the staged copy becomes writable. Dereference installed links so the cache owns its copied tools.
  tar --create --dereference --file=- --directory="$source" --mode=u+w . \
    | tar --extract --file=- --no-same-owner --directory="$destination"
  ci_go_verify "$destination"
}

ci_go_prepare_with_bootstrap() (
  set -euo pipefail
  local destination="$1" candidates invocation bootstrap='' candidate version root expected
  candidates="$(ci_go_bootstrap_candidates)"
  [ -n "$candidates" ] || { echo 'Go archive download failed and no installed bootstrap Go is available.' >&2; return 1; }
  invocation="$(mktemp -d "$FOREMAN_CODE_CI_GO_CACHE/toolchain-download.XXXXXX")"
  # Probing local compilers cannot populate a read-only module cache.
  trap 'rm -rf "$invocation"' EXIT
  export HOME="$invocation/home" GOCACHE="$invocation/build" GOMODCACHE="$invocation/modules" GOPATH="$invocation/gopath"
  export XDG_CONFIG_HOME="$HOME/config" XDG_CACHE_HOME="$HOME/cache" XDG_STATE_HOME="$HOME/state" TMPDIR="$invocation/tmp"
  export GOTMPDIR="$TMPDIR" GO111MODULE=on
  export GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS= GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
  export GOPRIVATE= GONOPROXY= GONOSUMDB= GOINSECURE=
  unset GOROOT
  mkdir -p "$HOME" "$GOCACHE" "$GOMODCACHE" "$GOPATH" "$TMPDIR" "$invocation/path"
  cd "$invocation"
  while IFS= read -r candidate; do
    if version="$("$candidate" env GOVERSION)"; then
      if [[ "$version" =~ ^go([0-9]+)\.([0-9]+)\.[0-9]+$ ]] \
        && (( 10#${BASH_REMATCH[1]} > 1 || (10#${BASH_REMATCH[1]} == 1 && 10#${BASH_REMATCH[2]} >= 21) )); then
        bootstrap="$candidate"
        break
      fi
      echo "Skipping bootstrap $candidate: a stable Go 1.21 or newer is required; found $version." >&2
    else
      echo "Failed to query the installed bootstrap Go at $candidate." >&2
    fi
  done <<< "$candidates"
  [ -n "$bootstrap" ] || { echo 'No installed stable Go 1.21 or newer can prepare the pinned toolchain.' >&2; return 1; }
  trap 'ci_go_module_cleanup "$?" "$bootstrap" "$invocation"' EXIT
  if [ "$version" = "go$ci_go_version" ]; then
    root="$("$bootstrap" env GOROOT)"
    if [[ "$root" != /* || ! -d "$root" || ! "$root/bin/go" -ef "$bootstrap" ]]; then
      echo "The installed Go root must contain the queried bootstrap compiler: $root." >&2
      return 1
    fi
    root="$(realpath "$root")"
    echo "Reusing trusted installed Go $ci_go_version from $root; source is the installed toolchain." >&2
  else
    # Go authenticates toolchain modules with sumdb. An empty PATH prevents versioned shims from taking precedence.
    root="$(PATH="$invocation/path" GOTOOLCHAIN="go$ci_go_version" "$bootstrap" env GOROOT)"
    expected="$GOMODCACHE/golang.org/toolchain@v0.0.1-go$ci_go_version.$ci_go_platform"
    [ "$root" = "$expected" ] || { echo "Downloaded Go must come from the owned toolchain module: $root." >&2; return 1; }
    echo "Using Go $ci_go_version from the authenticated toolchain module at $root." >&2
  fi
  ci_go_stage_toolchain "$root" "$destination"
)

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
    if curl --fail --location --retry 3 --output "$archive" "https://go.dev/dl/go$ci_go_version.$ci_go_platform.tar.gz"; then
      printf '%s  %s\n' "$ci_go_checksum" "$archive" | sha256sum --check --status -
      tar --extract --gzip --no-same-owner --file "$archive" --directory "$temporary"
    else
      echo 'Pinned Go archive download failed; trying an installed Go bootstrap.' >&2
      ci_go_prepare_with_bootstrap "$temporary/go"
    fi
    ci_go_verify "$temporary/go"
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
