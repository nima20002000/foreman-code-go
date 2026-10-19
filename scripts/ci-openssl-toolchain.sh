#!/bin/bash
# Only the committed selected OpenSSL profile calls this private CI prerequisite.

ci_openssl_require_commands() {
  local program
  for program in "$@"; do
    command -v "$program" >/dev/null 2>&1 || {
      echo "Selected OpenSSL CI requires existing $program; no system packages are installed by this helper." >&2
      return 1
    }
  done
}

ci_openssl_clean_environment() {
  local variable
  for variable in ${!OPENSSL_@}; do unset "$variable"; done
  unset SSLKEYLOGFILE LD_PRELOAD LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT NODE_OPTIONS CTLOG_FILE RANDFILE
  unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH CFLAGS CXXFLAGS CPPFLAGS LDFLAGS LIBS
  for variable in ${!PKG_CONFIG_@}; do unset "$variable"; done
  unset CGO_CFLAGS_ALLOW CGO_CFLAGS_DISALLOW CGO_CPPFLAGS_ALLOW CGO_CPPFLAGS_DISALLOW
  unset CGO_CXXFLAGS_ALLOW CGO_CXXFLAGS_DISALLOW CGO_LDFLAGS_ALLOW CGO_LDFLAGS_DISALLOW
  # Empty bootstrap locations apply before Node, pkg-config or any provider probe starts.
  export OPENSSL_CONF=/dev/null SSL_CERT_FILE=/dev/null SSL_CERT_DIR=/dev/null
  export OPENSSL_MODULES=/dev/null OPENSSL_ENGINES=/dev/null
  unset LD_LIBRARY_PATH
}

ci_openssl_environment() {
  ci_openssl_clean_environment
  ci_openssl_require_commands node cc pkg-config uname getconf realpath sha256sum || return $?
  [ -n "${CI_STATE:-}" ] || { echo 'Selected OpenSSL requires the current isolated CI_STATE.' >&2; return 1; }
  export CI_STATE="$(realpath -m "$CI_STATE")" || return $?
  local platform compiler compiler_hash compiler_version compiler_target libc pkg pkg_hash pkg_version settings cache
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) platform=linux-amd64 ;;
    Linux/aarch64|Linux/arm64) platform=linux-arm64 ;;
    *) echo 'Selected OpenSSL CI supports Linux amd64/arm64 with glibc only.' >&2; return 1 ;;
  esac
  compiler="$(realpath "$(command -v cc)")" || return $?
  compiler_hash="$(sha256sum "$compiler")" || return $?
  compiler_hash="${compiler_hash%% *}"
  compiler_version="$("$compiler" --version)" || return $?
  compiler_target="$("$compiler" -dumpmachine)" || return $?
  libc="$(getconf GNU_LIBC_VERSION)" || return $?
  pkg="$(realpath "$(command -v pkg-config)")" || return $?
  pkg_hash="$(sha256sum "$pkg")" || return $?
  pkg_hash="${pkg_hash%% *}"
  pkg_version="$("$pkg" --version)" || return $?
  cache="$(realpath -m "${FOREMAN_CODE_CI_OPENSSL_CACHE:-$HOME/.cache/foreman-openssl}")" || return $?
  ci_openssl_script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || return $?
  settings="$(node "$ci_openssl_script_directory/ci-openssl-binding.mjs" configuration \
    "$platform" "$compiler" "$compiler_hash" "$compiler_version" "$compiler_target" "$libc" "$pkg" "$pkg_hash" "$pkg_version" "$cache")" || return $?
  local values=()
  mapfile -t values <<< "$settings"
  [ "${#values[@]}" = 6 ] || { echo 'Invalid selected OpenSSL prerequisite configuration.' >&2; return 1; }
  ci_openssl_version="${values[0]}"
  ci_openssl_url="${values[2]}"
  ci_openssl_checksum="${values[3]}"
  ci_openssl_archive_size="${values[4]}"
  export FOREMAN_CODE_CI_OPENSSL_CACHE="$cache" FOREMAN_CODE_CI_OPENSSL_KEY="${values[1]}"
  export FOREMAN_CODE_CI_OPENSSL_PREFIX="$cache/toolchains/openssl-$ci_openssl_version-${values[1]}"
  export FOREMAN_CODE_CI_OPENSSL_IDENTITY="${values[5]}"
  export CC="$compiler" PKG_CONFIG="$pkg"
  export CGO_CFLAGS='-O2 -g' CGO_CPPFLAGS= CGO_CXXFLAGS='-O2 -g' CGO_LDFLAGS='-O2 -g'
  export PKG_CONFIG_PATH="$FOREMAN_CODE_CI_OPENSSL_PREFIX/lib/pkgconfig"
  export LD_LIBRARY_PATH="$FOREMAN_CODE_CI_OPENSSL_PREFIX/lib"
  local runtime
  runtime="$(realpath -m "$CI_STATE/go/openssl")" || return $?
  mkdir -p "$runtime/certs" || return $?
  chmod 700 "$runtime" "$runtime/certs" || return $?
  : > "$runtime/openssl.cnf"
  : > "$runtime/certs.pem"
  : > "$runtime/ct-logs.cnf"
  chmod 600 "$runtime/openssl.cnf" "$runtime/certs.pem" "$runtime/ct-logs.cnf" || return $?
  export OPENSSL_CONF="$runtime/openssl.cnf" OPENSSL_CONF_INCLUDE="$runtime"
  export SSL_CERT_FILE="$runtime/certs.pem" SSL_CERT_DIR="$runtime/certs" CTLOG_FILE="$runtime/ct-logs.cnf"
  export RANDFILE="$runtime/random-state" OPENSSL_MODULES="$FOREMAN_CODE_CI_OPENSSL_PREFIX/lib/ossl-modules"
  export OPENSSL_ENGINES="$FOREMAN_CODE_CI_OPENSSL_PREFIX/lib/engines-3"
  export FOREMAN_TLS_OPENSSL="$FOREMAN_CODE_CI_OPENSSL_PREFIX/bin/openssl"
}

ci_openssl_cleanup() {
  local status="$1" owned="$2"
  if ! rm -rf -- "$owned"; then
    echo "Could not clean the owned OpenSSL prerequisite directory: $owned" >&2
    if [ "$status" = 0 ]; then status=1; fi
  fi
  exit "$status"
}

ci_openssl_install() (
  set -euo pipefail
  umask 077
  ci_openssl_environment
  ci_openssl_require_commands flock curl tar make perl
  mkdir -p "$FOREMAN_CODE_CI_OPENSSL_CACHE/toolchains"
  exec 9> "$FOREMAN_CODE_CI_OPENSSL_CACHE/install-$FOREMAN_CODE_CI_OPENSSL_KEY.lock"
  flock 9
  if [ -e "$FOREMAN_CODE_CI_OPENSSL_PREFIX" ]; then
    node "$ci_openssl_script_directory/ci-openssl-binding.mjs" verify-install
    return
  fi
  local temporary archive jobs target staged
  temporary="$(mktemp -d "$FOREMAN_CODE_CI_OPENSSL_CACHE/install.XXXXXX")"
  trap 'ci_openssl_cleanup "$?" "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  archive="$temporary/openssl.tar.gz"
  # Source transport uses the disposable build image's normal public HTTPS roots.
  # Empty material-test stores must not disable verified source downloads; user
  # curl/CA overrides remain excluded, and provider configuration stays empty.
  env -u SSL_CERT_FILE -u SSL_CERT_DIR -u CURL_CA_BUNDLE -u LD_LIBRARY_PATH \
    -u OPENSSL_MODULES -u OPENSSL_ENGINES curl --disable --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
    --proto '=https' --proto-redir '=https' --output "$archive" "$ci_openssl_url"
  [ "$(wc -c < "$archive")" = "$ci_openssl_archive_size" ] || {
    echo 'Pinned OpenSSL source size mismatch; refusing to extract or build.' >&2; return 1;
  }
  printf '%s  %s\n' "$ci_openssl_checksum" "$archive" | sha256sum --check --status - || {
    echo 'Pinned OpenSSL source checksum mismatch; refusing to extract or build.' >&2; return 1;
  }
  mkdir "$temporary/source"
  tar --extract --gzip --no-same-owner --strip-components=1 --file "$archive" --directory "$temporary/source"
  jobs="${FOREMAN_CODE_CI_CPU_COUNT:-$(node --input-type=module -e 'import { availableParallelism } from "node:os"; console.log(availableParallelism())')}"
  [[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'FOREMAN_CODE_CI_CPU_COUNT must be a positive integer.' >&2; return 1; }
  case "$(uname -m)" in x86_64) target=linux-x86_64 ;; aarch64|arm64) target=linux-aarch64 ;; esac
  unset CONFIG_SITE MAKEFLAGS MFLAGS PERL5LIB PERL5OPT
  export CFLAGS='-O2 -fPIC'
  cd "$temporary/source"
  perl ./Configure "$target" shared no-tests --prefix="$FOREMAN_CODE_CI_OPENSSL_PREFIX" \
    --openssldir="$FOREMAN_CODE_CI_OPENSSL_PREFIX/ssl" --libdir=lib
  make -j "$jobs"
  # The published prefix is encoded in pkg-config and library defaults. DESTDIR
  # stages its bytes privately without publishing a partial installation.
  make install_sw DESTDIR="$temporary/stage"
  staged="$temporary/stage$FOREMAN_CODE_CI_OPENSSL_PREFIX"
  node "$ci_openssl_script_directory/ci-openssl-binding.mjs" record-install "$staged"
  mv "$staged" "$FOREMAN_CODE_CI_OPENSSL_PREFIX"
  node "$ci_openssl_script_directory/ci-openssl-binding.mjs" verify-install
)

ci_openssl_verify() (
  set -euo pipefail
  umask 077
  ci_openssl_environment
  ci_openssl_require_commands go
  local cgo compiler temporary runtime prefix
  cgo="$(go env CGO_ENABLED)"
  [ "$cgo" = 1 ] || { echo 'OpenSSL provider prerequisite is unavailable: actual CGO_ENABLED must be 1.' >&2; return 1; }
  compiler="$(go env CC)"
  [ "$compiler" = "$CC" ] || { echo 'Go must use the identified OpenSSL C compiler.' >&2; return 1; }
  node "$ci_openssl_script_directory/ci-openssl-binding.mjs" verify-install
  prefix="$FOREMAN_CODE_CI_OPENSSL_PREFIX"
  [ "$("$PKG_CONFIG" --modversion openssl)" = "$ci_openssl_version" ] \
    && [ "$("$PKG_CONFIG" --variable=prefix openssl)" = "$prefix" ] \
    && [ "$("$PKG_CONFIG" --variable=includedir openssl)" = "$prefix/include" ] \
    && [ "$("$PKG_CONFIG" --variable=libdir openssl)" = "$prefix/lib" ] || {
    echo 'pkg-config did not select the pinned OpenSSL headers and libraries.' >&2; return 1;
  }
  runtime="$(realpath -m "$CI_STATE/go/openssl")"
  temporary="$(mktemp -d "$runtime/prerequisite.XXXXXX")"
  trap 'ci_openssl_cleanup "$?" "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "$PKG_CONFIG" --cflags openssl > "$runtime/pkg-config.cflags"
  "$PKG_CONFIG" --libs openssl > "$runtime/pkg-config.libs"
  node "$ci_openssl_script_directory/ci-openssl-binding.mjs" compile-binding "$temporary"
  "$temporary/binding" > "$runtime/binding.stdout"
  "$FOREMAN_TLS_OPENSSL" version > "$runtime/cli-version.stdout"
  node "$ci_openssl_script_directory/ci-openssl-binding.mjs" record-prerequisite \
    "$runtime/binding.stdout" "$runtime/pkg-config.cflags" "$runtime/pkg-config.libs" "$cgo" "$compiler" "$runtime/cli-version.stdout"
)

ci_openssl_export_environment() {
  ci_openssl_environment || return $?
  printf '%s\n' 'for ci_openssl_variable in ${!OPENSSL_@}; do unset "$ci_openssl_variable"; done'
  printf '%s\n' 'unset SSLKEYLOGFILE LD_PRELOAD LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT NODE_OPTIONS CTLOG_FILE RANDFILE'
  printf '%s\n' 'unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH CFLAGS CXXFLAGS CPPFLAGS LDFLAGS LIBS'
  printf '%s\n' 'for ci_openssl_variable in ${!PKG_CONFIG_@}; do unset "$ci_openssl_variable"; done'
  printf '%s\n' 'unset CGO_CFLAGS_ALLOW CGO_CFLAGS_DISALLOW CGO_CPPFLAGS_ALLOW CGO_CPPFLAGS_DISALLOW CGO_CXXFLAGS_ALLOW CGO_CXXFLAGS_DISALLOW CGO_LDFLAGS_ALLOW CGO_LDFLAGS_DISALLOW'
  local variable
  for variable in CI_STATE FOREMAN_CODE_CI_OPENSSL_CACHE FOREMAN_CODE_CI_OPENSSL_PREFIX FOREMAN_CODE_CI_OPENSSL_KEY \
    FOREMAN_CODE_CI_OPENSSL_IDENTITY CC PKG_CONFIG CGO_CFLAGS CGO_CPPFLAGS CGO_CXXFLAGS CGO_LDFLAGS \
    PKG_CONFIG_PATH LD_LIBRARY_PATH OPENSSL_CONF OPENSSL_CONF_INCLUDE SSL_CERT_FILE SSL_CERT_DIR \
    CTLOG_FILE RANDFILE OPENSSL_MODULES OPENSSL_ENGINES FOREMAN_TLS_OPENSSL; do
    printf 'export %s=%q\n' "$variable" "${!variable}"
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  case "${1:-}" in
    install) ci_openssl_install ;;
    environment) ci_openssl_export_environment ;;
    verify) ci_openssl_verify ;;
    cache-key) ci_openssl_environment; printf '%s\n' "$FOREMAN_CODE_CI_OPENSSL_KEY" ;;
    *) echo 'Usage: ci-openssl-toolchain.sh install|environment|verify|cache-key' >&2; exit 2 ;;
  esac
fi
