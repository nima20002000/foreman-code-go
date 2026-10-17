#!/bin/bash
# PostgreSQL is compiled only inside the CI cache. Q-CONF owns every runtime cluster.

ci_postgres_require_commands() {
  local command
  for command in "$@"; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "PostgreSQL conformance requires $command in the existing build image; this helper does not install system packages on build computers." >&2
      return 1
    fi
  done
}

ci_postgres_environment() {
  ci_postgres_require_commands node cc getconf realpath || return $?
  local platform compiler libc settings cache
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) platform=linux-amd64 ;;
    Linux/aarch64|Linux/arm64) platform=linux-arm64 ;;
    *) echo 'PostgreSQL CI supports Linux amd64 and arm64 build computers.' >&2; return 1 ;;
  esac
  compiler="$(cc --version)" || return $?
  libc="$(getconf GNU_LIBC_VERSION)" || return $?
  ci_postgres_script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || return $?
  settings="$(node --input-type=module - "$ci_postgres_script_directory" "$platform" "$compiler" "$libc" <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const [directory, ...platform] = process.argv.slice(2)
const pins = JSON.parse(readFileSync(join(directory, 'ci-postgres-versions.json'), 'utf8'))
const hash = createHash('sha256')
for (const name of ['postgresql', 'm4', 'bison', 'flex']) {
  const pin = pins[name]
  if (!pin || !/^\d+\.\d+(\.\d+)?$/.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.sha256)
    || !/^https:\/\/[^\s]+$/.test(pin.url) || !Number.isFinite(Date.parse(pin.released))
    || (pin.fallbackUrls !== undefined && (!Array.isArray(pin.fallbackUrls)
      || pin.fallbackUrls.some(url => typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url))))
    || Date.now() - Date.parse(pin.released) < 48 * 3_600_000
    || (pin.sha1 !== undefined && !/^[a-f0-9]{40}$/.test(pin.sha1))) {
    throw new Error(`${name} must have an exact version, verified archive checksum and release at least 48 hours old.`)
  }
  if (pin.patches !== undefined && !Array.isArray(pin.patches)) {
    throw new Error(`${name} patches must be an ordered array.`)
  }
  for (const patch of pin.patches ?? []) {
    if (!patch || !/^[a-f0-9]{64}$/.test(patch.sha256)
      || typeof patch.file !== 'string' || !/^ci-postgres-patches\/[a-zA-Z0-9._/-]+\.patch$/.test(patch.file)
      || patch.file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`${name} requires a cache-local source patch path and exact SHA-256.`)
    }
    const content = readFileSync(join(directory, patch.file))
    if (createHash('sha256').update(content).digest('hex') !== patch.sha256) {
      throw new Error(`SHA-256 mismatch for PostgreSQL build source patch ${patch.file}.`)
    }
    hash.update(patch.file).update('\0').update(content).update('\0')
  }
}
for (const file of ['ci-postgres-versions.json', 'ci-postgres-toolchain.sh', 'ci-postgres-tool-wrapper.sh']) {
  hash.update(readFileSync(join(directory, file))).update('\0')
}
for (const value of platform) hash.update(value).update('\0')
console.log(`${pins.postgresql.version}\n${hash.digest('hex')}`)
NODE
  )" || return $?
  local values=()
  mapfile -t values <<< "$settings"
  [ "${#values[@]}" = 2 ] || { echo 'Invalid PostgreSQL toolchain configuration.' >&2; return 1; }
  ci_postgres_version="${values[0]}"
  ci_postgres_cache_key="${values[1]}"
  cache="$(realpath -m "${FOREMAN_CODE_CI_POSTGRES_CACHE:-$HOME/.cache/foreman-postgres}")" || return $?
  export FOREMAN_CODE_CI_POSTGRES_CACHE="$cache"
  ci_postgres_directory="$FOREMAN_CODE_CI_POSTGRES_CACHE/toolchains/postgresql-$ci_postgres_version-$ci_postgres_cache_key"
  export CONFORMANCE_POSTGRES_BIN_DIR="$ci_postgres_directory/bin"
}

ci_postgres_require_user() {
  if [ "$EUID" = 0 ]; then
    echo 'PostgreSQL conformance requires an existing unprivileged CI user. This helper never switches users or changes CI-computer settings.' >&2
    return 1
  fi
}

ci_postgres_verify_directory() {
  local directory="$1" tool version
  for tool in initdb postgres pg_isready psql createdb pg_ctl pg_config pg_dump pg_restore; do
    [ -x "$directory/$tool" ] || { echo "Pinned PostgreSQL $tool is missing; run ci-suite.sh start or prepare." >&2; return 1; }
    # Match Q-CONF's child environment: no inherited dynamic-loader or PostgreSQL variables.
    version="$(env -i PATH="$PATH" LANG=C LC_ALL=C "$directory/$tool" --version)" || return $?
    case "$version" in
      "$tool (PostgreSQL) $ci_postgres_version"|"PostgreSQL $ci_postgres_version") ;;
      *) echo "Expected PostgreSQL $ci_postgres_version; cached $tool reports $version." >&2; return 1 ;;
    esac
  done
}

ci_postgres_verify() {
  ci_postgres_require_user || return $?
  ci_postgres_require_commands git openssl ss || return $?
  ci_postgres_verify_directory "$CONFORMANCE_POSTGRES_BIN_DIR"
}

ci_postgres_unpack() {
  local name="$1" source_directory="$2" settings
  settings="$(node --input-type=module - "$ci_postgres_script_directory/ci-postgres-versions.json" "$name" <<'NODE'
import { readFileSync } from 'node:fs'
const pin = JSON.parse(readFileSync(process.argv[2], 'utf8'))[process.argv[3]]
console.log([pin.sha256, pin.sha1 ?? '', pin.url, ...(pin.fallbackUrls ?? [])].join('\n'))
NODE
  )" || return $?
  local pin=()
  mapfile -t pin <<< "$settings"
  local archive="$source_directory.tar.gz" url downloaded=0
  for url in "${pin[@]:2}"; do
    # A failed transfer can leave bytes behind. Each official mirror starts clean.
    rm -f "$archive"
    if curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
      --proto '=https' --proto-redir '=https' --output "$archive" "$url"; then
      downloaded=1
      break
    fi
    echo "Could not download PostgreSQL build source $name from $url; trying the next pinned location if available." >&2
  done
  if [ "$downloaded" != 1 ]; then
    echo "All pinned download locations failed for PostgreSQL build source $name." >&2
    return 1
  fi
  # Mirrors change transport only. A completed transfer with the wrong digest is fatal.
  if ! printf '%s  %s\n' "${pin[0]}" "$archive" | sha256sum --check --status -; then
    echo "SHA-256 mismatch for PostgreSQL build source $name; refusing to extract or build it." >&2
    return 1
  fi
  # Flex's upstream announcement and Debian's original-source metadata share this hash.
  if [ -n "${pin[1]:-}" ] && ! printf '%s  %s\n' "${pin[1]}" "$archive" | sha1sum --check --status -; then
    echo "Upstream SHA-1 mismatch for PostgreSQL build source $name; refusing to extract or build it." >&2
    return 1
  fi
  mkdir -p "$source_directory"
  tar --extract --gzip --no-same-owner --strip-components=1 --file "$archive" --directory "$source_directory" || return $?
  ci_postgres_apply_patches "$name" "$source_directory"
}

ci_postgres_apply_patches() {
  local name="$1" source_directory="$2" settings digest relative file
  settings="$(node --input-type=module - "$ci_postgres_script_directory/ci-postgres-versions.json" "$name" <<'NODE'
import { readFileSync } from 'node:fs'
const pin = JSON.parse(readFileSync(process.argv[2], 'utf8'))[process.argv[3]]
for (const patch of pin.patches ?? []) console.log(`${patch.sha256}\t${patch.file}`)
NODE
  )" || return $?
  [ -n "$settings" ] || return 0
  while IFS=$'\t' read -r digest relative; do
    file="$ci_postgres_script_directory/$relative"
    if ! printf '%s  %s\n' "$digest" "$file" | sha256sum --check --status -; then
      echo "SHA-256 mismatch for PostgreSQL build source patch $relative; refusing to build." >&2
      return 1
    fi
    # These are pinned upstream backports, applied only to the verified cache copy.
    # C23 libc function macros need source compatibility; a C-standard flag is insufficient.
    if ! patch --batch --forward --fuzz=0 --strip=1 --directory="$source_directory" --input="$file"; then
      echo "Could not apply pinned PostgreSQL build source patch $relative; refusing to build." >&2
      return 1
    fi
  done <<< "$settings"
}

ci_postgres_wrap_tools() {
  local directory="$1" binary
  mkdir -p "$directory/bin"
  for binary in "$directory/installation/bin/"*; do
    [ -f "$binary" ] && [ -x "$binary" ] || continue
    cp "$ci_postgres_script_directory/ci-postgres-tool-wrapper.sh" "$directory/bin/${binary##*/}"
    chmod 755 "$directory/bin/${binary##*/}"
  done
}

ci_postgres_build_parser_tools() (
  set -euo pipefail
  local temporary="$1" prefix="$1/toolchain/parser-tools/installation" jobs="$2" name
  for name in m4 bison flex; do
    echo "Preparing cached PostgreSQL build tool: $name"
    ci_postgres_unpack "$name" "$temporary/$name-source"
    mkdir -p "$temporary/$name-build"
    cd "$temporary/$name-build"
    if [ "$name" = flex ]; then
      # Only the scanner is needed, not its optional libfl, examples or documentation.
      CPPFLAGS=-D_GNU_SOURCE "$temporary/$name-source/configure" --prefix="$prefix" --disable-nls --disable-libfl
      make -j "$jobs" SUBDIRS=src
      make SUBDIRS=src install
    else
      "$temporary/$name-source/configure" --prefix="$prefix" --disable-nls
      make -j "$jobs"
      make install
    fi
    ci_postgres_wrap_tools "$temporary/toolchain/parser-tools"
    export PATH="$temporary/toolchain/parser-tools/bin:$PATH"
  done
)

ci_postgres_build_server() (
  set -euo pipefail
  local temporary="$1" jobs="$2"
  ci_postgres_unpack postgresql "$temporary/postgresql-source"
  mkdir -p "$temporary/postgresql-build"
  cd "$temporary/postgresql-build"
  export PATH="$temporary/toolchain/parser-tools/bin:$PATH"
  "$temporary/postgresql-source/configure" --prefix="$temporary/toolchain/installation" \
    --without-icu --without-readline --without-zlib --disable-rpath
  make -j "$jobs"
  make install
  ci_postgres_wrap_tools "$temporary/toolchain"
  ci_postgres_verify_directory "$temporary/toolchain/bin"
)

ci_postgres_install() (
  set -euo pipefail
  umask 077
  ci_postgres_require_user
  ci_postgres_environment
  ci_postgres_require_commands git openssl ss flock
  mkdir -p "$FOREMAN_CODE_CI_POSTGRES_CACHE/toolchains"
  # Independently dispatched parts can share this cache without publishing half an install.
  exec 9> "$FOREMAN_CODE_CI_POSTGRES_CACHE/install.lock"
  flock 9
  if [ -x "$CONFORMANCE_POSTGRES_BIN_DIR/postgres" ]; then
    if ci_postgres_verify; then return 0; fi
    echo 'Rebuilding the unusable cached PostgreSQL installation.' >&2
  fi
  ci_postgres_require_commands make perl c++ curl tar sha256sum sha1sum patch
  local temporary jobs
  jobs="${FOREMAN_CODE_CI_CPU_COUNT:-$(node --input-type=module -e 'import { availableParallelism } from "node:os"; console.log(availableParallelism())')}"
  [[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'FOREMAN_CODE_CI_CPU_COUNT must be a positive integer.' >&2; return 1; }
  temporary="$(mktemp -d "$FOREMAN_CODE_CI_POSTGRES_CACHE/install.XXXXXX")"
  trap 'rm -rf "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The source build must not pick up a user's compiler flags, parser tools or configure site.
  unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS LIBS CONFIG_SITE MAKEFLAGS MFLAGS M4 BISON_PKGDATADIR
  export CC=cc CXX=c++
  ci_postgres_build_parser_tools "$temporary" "$jobs"
  ci_postgres_build_server "$temporary" "$jobs"
  rm -rf "$ci_postgres_directory"
  mv "$temporary/toolchain" "$ci_postgres_directory"
  ci_postgres_verify
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  case "${1:-}" in
    install) ci_postgres_install ;;
    verify) ci_postgres_environment; ci_postgres_verify ;;
    environment)
      ci_postgres_environment
      printf 'export FOREMAN_CODE_CI_POSTGRES_CACHE=%q\nexport CONFORMANCE_POSTGRES_BIN_DIR=%q\n' \
        "$FOREMAN_CODE_CI_POSTGRES_CACHE" "$CONFORMANCE_POSTGRES_BIN_DIR" ;;
    cache-key) ci_postgres_environment; printf '%s\n' "$ci_postgres_cache_key" ;;
    *) echo 'Usage: ci-postgres-toolchain.sh install|environment|verify|cache-key' >&2; exit 2 ;;
  esac
fi
