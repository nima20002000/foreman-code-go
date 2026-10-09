#!/bin/sh
set -eu
backing=${1:?usage: create-volume.sh <new-backing-file> <size>}
size=${2:?volume size required}

# Refuse replacement before either allocation or formatting touches the destination.
(set -C; : > "$backing")
fallocate -l "$size" "$backing"
# Formatting must retain the physical reservation made by fallocate.
mkfs.ext4 -q -O quota,project -E quotatype=prjquota,nodiscard "$backing"
bytes=$(stat -c %s "$backing")
blocks=$(stat -c %b "$backing")
if [ "$((blocks * 512))" -lt "$bytes" ]; then
  echo 'Volume creation did not preserve its full backing allocation.' >&2
  exit 1
fi
