#!/bin/sh
# Resolve the installation after a provider restores the cache in another checkout.
set -eu
installation="$(CDPATH= cd -- "$(dirname -- "$0")/../installation" && pwd -P)"
export LD_LIBRARY_PATH="$installation/lib"
case "${0##*/}" in
  bison)
    export BISON_PKGDATADIR="$installation/share/bison"
    export M4="$installation/bin/m4" ;;
  flex) export M4="$installation/bin/m4" ;;
esac
exec "$installation/bin/${0##*/}" "$@"
