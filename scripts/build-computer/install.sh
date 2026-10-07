#!/bin/sh
# Root-once setup for a computer that runs CI Jobs. Everything later (offline packages, image,
# protected runtime refresh and requalification) the app does itself as the computer's user.
#
#   sudo scripts/build-computer/install.sh <user> <job-quota-query> [volume-GiB] [installation-plan.json]
#
# - an ext4 volume with project quotas, mounted persistently at ~/.local/share/foreman-code/ci-verification/volume
# - the read-only quota observer from the Worker artifact, with only the capability its quota reads need
# - rootless podman prerequisites (podman, crun, subordinate ids)
# - with an installation plan: the control and per-Job quota directories (provision-quotas.py)
set -eu
user=${1:?usage: install.sh <user> <job-quota-query> [volume-GiB] [installation-plan.json]}
observer=${2:?path to artifacts/job-quota-query in the Worker artifact}
size=${3:-96}
plan=${4:-}
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || { echo "Unknown user $user." >&2; exit 1; }
base=$home/.local/share/foreman-code/ci-verification
volume=$base/volume
backing=/var/lib/foreman-code-ci/verification.ext4

apt-get install -y --no-install-recommends podman crun uidmap e2fsprogs quota libcap2-bin
grep -q "^$user:" /etc/subuid || usermod --add-subuids 100000-165535 "$user"
grep -q "^$user:" /etc/subgid || usermod --add-subgids 100000-165535 "$user"

install -d -m 0700 /var/lib/foreman-code-ci
if [ ! -f "$backing" ]; then
  fallocate -l "${size}G" "$backing"
  mkfs.ext4 -q -O quota,project -E quotatype=prjquota "$backing"
fi
install -d -m 0700 -o "$user" -g "$(id -gn "$user")" "$home/.local/share/foreman-code" "$base" "$volume"
unit=$(systemd-escape -p --suffix=mount "$volume")
cat > "/etc/systemd/system/$unit" <<UNIT
[Unit]
Description=Foreman Code CI verification volume

[Mount]
What=$backing
Where=$volume
Type=ext4
Options=loop,nosuid,nodev,prjquota

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "$unit"
chown "$user:$(id -gn "$user")" "$volume"
chmod 0700 "$volume"

install -d -m 0755 /usr/local/lib/foreman-code-ci
install -m 0755 "$observer" /usr/local/lib/foreman-code-ci/job-quota-query
setcap cap_sys_admin=ep /usr/local/lib/foreman-code-ci/job-quota-query

if [ -n "$plan" ]; then python3 "$(dirname "$0")/provision-quotas.py" "$plan"; fi
echo "Build computer volume ready at $volume"
