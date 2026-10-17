#!/bin/bash
# CI_STATE remains the provider's artifact/lifecycle anchor. Runtime files live outside repository package scope.

ci_runtime_validate() {
  local owner mode
  [[ "${ci_runtime_root:-}" =~ ^/tmp/fci\.[A-Za-z0-9]{6}$ ]] \
    && [ -d "$ci_runtime_root" ] && [ ! -L "$ci_runtime_root" ] && [ -O "$ci_runtime_root" ] \
    && [ -f "$ci_runtime_root/ci-state" ] && [ ! -L "$ci_runtime_root/ci-state" ] && [ -O "$ci_runtime_root/ci-state" ] \
    || { echo 'The recorded CI runtime directory is not an owned private runtime.' >&2; return 1; }
  mode="$(stat -c '%a' "$ci_runtime_root")" || return $?
  [ "$mode" = 700 ] || { echo 'The CI runtime directory must remain private (0700).' >&2; return 1; }
  mode="$(stat -c '%a' "$ci_runtime_root/ci-state")" || return $?
  [ "$mode" = 600 ] || { echo 'The CI runtime binding must remain private (0600).' >&2; return 1; }
  IFS= read -r owner < "$ci_runtime_root/ci-state" || return $?
  [ "$owner" = "$CI_STATE" ] || { echo 'The recorded runtime belongs to another CI state directory.' >&2; return 1; }
}

ci_runtime_load() {
  local record="$CI_STATE/runtime-root" mode
  ci_runtime_root=''
  if [ -e "$record" ] || [ -L "$record" ]; then
    [ -f "$record" ] && [ ! -L "$record" ] && [ -O "$record" ] \
      || { echo 'Invalid CI runtime lifecycle record.' >&2; return 1; }
    mode="$(stat -c '%a' "$record")" || return $?
    [ "$mode" = 600 ] || { echo 'The CI runtime lifecycle record must remain private (0600).' >&2; return 1; }
    IFS= read -r ci_runtime_root < "$record" || return $?
    ci_runtime_validate || return $?
  fi
}

ci_runtime_environment() {
  export HOME="$ci_runtime_root/home" TMPDIR="$ci_runtime_root/tmp"
  export TMP="$TMPDIR" TEMP="$TMPDIR"
  export XDG_CONFIG_HOME="$HOME/.config" XDG_STATE_HOME="$HOME/.local/state" XDG_CACHE_HOME="$HOME/.cache"
  export CODEX_HOME="$HOME/.codex" CLAUDE_CONFIG_DIR="$HOME/.claude"
}

ci_runtime_initialize() {
  local record="$CI_STATE/runtime-root"
  ci_runtime_load || return $?
  if [ -z "$ci_runtime_root" ]; then
    ci_runtime_root="$(mktemp -d /tmp/fci.XXXXXX)" || return $?
    if ! printf '%s\n' "$CI_STATE" > "$ci_runtime_root/ci-state" || ! printf '%s\n' "$ci_runtime_root" > "$record"; then
      echo 'Unable to record the private CI runtime directory.' >&2
      if rm -rf "$ci_runtime_root"; then ci_runtime_root=''; else echo 'Unable to remove the unrecorded runtime directory.' >&2; fi
      return 1
    fi
  fi
  ci_runtime_environment
  mkdir -p "$HOME" "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" || return $?
}

ci_runtime_cleanup() {
  [ -n "${ci_runtime_root:-}" ] || return 0
  ci_runtime_validate || return $?
  rm -rf "$ci_runtime_root" || return $?
  rm -f "$CI_STATE/runtime-root"
}
