# CI job executor and isolation qualification

CI-A owns `apps/api/src/modules/jobs/executor*.ts` and the three
`scripts/fixtures/ci-*.mjs` fixtures. The executor accepts the shared immutable
JobExecution; it does not create an Agent, provider session, scheduler, database
or remote connection. W07 supplies the surviving worker service and carrier;
W08 supplies durable claims, cancellation, current authority and attempt/owner
fencing; W09 verifies private Git source and publishes declared output bytes.
Lane B composes these ports and its durable result/log sink into production.

`createJobWorkerHandler` is the carrier entry. Its settlement callback must
check attempt and owner and persist observed process outcome independently of
publication. A reconciliation claim returns recoveryRequired with no spawn;
missing container evidence is uncertainty. A lost launched receipt does not
erase an observed exit. A terminal execution cannot be launched again.

The sole implemented isolation profile is qualified offline rootless Podman.
There is no installed or qualified profile implied by this source change.
The controller supplies an absolute verified runtime path, allowlisted
controller environment and a persisted, human-approved qualification record
with exact Podman/OCI/kernel/toolchain/image versions and tested cgroup v2,
filesystem quota, process containment, CPU/memory/pids/disk controls. W07/W08
recheck current identity/capability/revocation against the accepted placement.
W09 source verification must prove a private usable Git repository, accepted
canonical directory identity, inputs/source digests, and enforced disk quota.
No external Git common directory, hooks, helpers or credentials may enter it.

The actual Node CLI adapter uses closed stdin and piped stdout/stderr. Podman
create pins an existing image digest (`--pull=never`), private namespaces,
read-only image, one quota-bound private source mount, bounded tmpfs, dropped
capabilities, no-new-privileges, no network, finite CPU/memory/pids limits,
cleared default environment and no restart. Controller/transfer authority stays
outside this mount. Approved dependency network access or secret environment
scopes are unsupported and fail closed; they need a separately qualified
profile rather than a fallback. Local repository development installation is
separate from any real worker installation/preparation approval.

Each launch has a deterministic name and exact spec/attempt labels. Inspect,
wait and stop use the immutable container ID and validate its labels; no bare
PID is killed. Terminal cancellation/timeout and resource release require
positive stopped-container evidence under the qualified descendant-containment
contract. Unknown state retains ownership for W08 reconciliation. No container
is automatically removed; W08 releases retained evidence after durable receipts.

Worker timeout runs independently of the main connection. UTF8 logs are bounded
and serialized into the durable sink. Half of the accepted spool byte budget
is reserved for bounded retained OCI logs, half for sink chunks. Runtime log
rotation/control framing and root quota must be included in qualification.
Reconciliation conservatively exposes `logGapPossible` until W08/B recovers
retained logs with an acknowledged cursor; it never claims lossless replay.
Log or output storage errors preserve the observed process exit. W09 output
collection only follows positive quiescence; the local helper opens directory
components and regular files no-follow, rejects hard links/special files, and
bounds aggregate bytes. It does not publish a canonical file revision.

Tests use supervisor/CLI doubles and temporary output files. They are focused
contract tests, not live isolation, reboot/reconnect or laptop qualification.
Only the orchestrator runs integration/laptop acceptance after explicit human
installation, source/root, capacity, runtime/image and readiness gates.
