# Independent Job project quotas

Verification Jobs use installer-provisioned ext4 project-quota directories. The
protected runtime descriptor and fingerprint record `quotaPool`: a pinned
`queryExecutable` and `queryBinarySha256`, the mounted `blockDevice`, the observed
`volumeCapacityInodes`, and independent `slots`. Each slot records a UUID
namespace, project ID, byte and inode hard limits, and its directory filesystem
identity. Project IDs are distinct from one another and from the control project.
The total hard limits, including control storage, fit the device and volume.

The worker artifact supplies the read-only `artifacts/job-quota-query` observer
and its C source. The artifact build requires a Linux x64 C compiler. Installation
preserves execution permission for this observer without granting elevated
privileges. The observer reads filesystem/project identity, inheritance, current
usage and hard limits using `FS_IOC_FSGETXATTR`, `Q_GETINFO` and `Q_GETQUOTA`.
The installer must explicitly provide any host permissions required for these
read operations. The application never runs quota mutation commands, adds
privileges, or exposes the observer as an agent tool. Its executable and digest
are protected installation inputs, not values supplied by a Job or agent.

The installer must provision every slot's project identity, inheritance and hard
limits before qualification. Readback alone does not establish enforcement:
qualification exercises byte and inode exhaustion and independent sibling
writes through the actual runtime. Its measured allowance and the reviewed
owner configuration bound admission to four Main Jobs or two laptop Jobs. The
source reservation service uses those same measured limits for verification
preparation. Other source workflows retain their existing limits.

A Job receives a fresh materialization UUID within its claimed quota slot. The
immutable source receipt records the slot; source, Git metadata, dependencies,
scratch and reports stay under that identity. Attempt and slot claims are synced
before source copying. Recovery restores the original claim and directory,
including a crash between writing the two claims.

After Main retains the canonical source snapshot and closes the process and
publication, it authorizes cleanup of that original Job directory. Cleanup is
bounded by the original deadline, preserves control-side release records, and
keeps the slot claimed until the kernel reports no remaining Job blocks or
inodes, including open deleted files. Cancellation applies the same rule to
incomplete preparations. Retried cleanup reads the original records and cannot
release or delete a later Job's ownership. Reservations are reclaimed only after
this physical cleanup succeeds.
