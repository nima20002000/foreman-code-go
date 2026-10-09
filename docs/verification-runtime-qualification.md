# Verification runtime qualification

Verification profiles retain an approved source commit, immutable image and
toolchain, offline dependency receipt, independent project quotas and a reviewed
resource envelope. A paired computer captures its installed runtime and qualifies
it directly; there is no approval step. Qualification lasts 24 hours. A Job may run
any commit whose dependency files match the qualification commit; changed
dependency files wait for a qualification with a matching offline seed.

The installed host runs install, typecheck, lint, unit and build inside rootless
containers with private network namespaces and no network. Dependencies must be
pre-seeded with the strict 2,880-minute package release-age policy. The qualifier
checks effective pnpm settings, owner-home isolation, resource usage and physical
byte/inode quota denial.

The container launcher reports `FOREMAN_CODE_VERIFICATION_ENVIRONMENT=isolated-job-v1`.
The shared `verificationEnvironment` contract describes this runtime as providing
Job-private PostgreSQL and separately mounted read-only Git metadata. It does
**not** provide delegated child cgroups, Docker Compose, or an installed Worker
host (`installedWorkerHost=false`). The Debian Job image is not an approved
Worker packaging target, and its ephemeral root does not satisfy Worker storage
persistence policy. Outer Job containment
does not imply that a nested native harness can create its own `cgroup.kill`
boundary. No host Docker socket, privileges, or writable host cgroup mount is
provided. The smoke controller reads the fixed Git mount for checkout identity
and builds; application processes retain their isolated environment.

The integration runner reads this contract before scheduling tests. Native
local-human isolation and Operator file-delivery/management suites require
`nativeCgroupDelegation`; the shared Compose database-startup test requires
`dockerCompose`. The computer workflow-save regression, remote production review,
Worker chat-profile qualification and Worker profile requalification suites require
`installedWorkerHost`: a host matching an approved Worker packaging target's OS,
release, architecture, libc and Node version, with persistent root, home and
disposable-test state storage. Outside a Job the runner uses the Worker's host-fact
probe and the committed packaging targets to determine this capability, and probes
existing delegation and Docker availability without starting or configuring
services. Job declarations are read without host probing. Worker target and
persistence policy remain unchanged. Its `summary.json`
records the environment, every required file, and each unavailable file's missing
capabilities. Unavailable files have no test results, are not marked skipped or
passed, and keep the full run **incomplete with a nonzero exit**. Explicit file
selection cannot turn an unavailable file into success. Run those same files on
a host with the required capabilities to obtain their coverage; an image-only
result is not a full integration gate. The original protected test inventory and
publication completeness checks still apply. Operators can read these diagnostics
from the published logs archive using the existing scoped artifact tools.

Each ordinary suite closes its original container before reports are finalized
and published through the canonical Job file store. Publication verifies the
declared byte limits and reads retained bytes back by file ID, revision and hash.
Exit zero or a report left in the workspace does not qualify a profile.

Additional diagnostics run an ordinary suite, exhaust the same Job quota, and
remain active for cancellation and the original execution deadline. The host
stops their owned container and descendants. The shared Job finalizer reclaims
only the closed workload's caches and consumes a protected report reservation.
Partial counts, failures and cancellation/timeout outcomes remain visible in
bounded summary, JUnit, Vitest and log artifacts. Storage capacity is released
only after the original qualification owner has closed and reclaimed its quota.

Operator MCP can save/request/run/read qualification using the existing tools.
Verification qualification requires `job_definitions:write`, `jobs:start` and
`job_artifacts:read`. Measured qualification records
include diagnostic execution IDs and canonical artifact references. Operators
read them through `job_get`, `job_artifacts_list` and `job_artifact_read`; ordinary
verification Jobs use `job_choices_get`, `job_definition_save` and `job_start`, or
`ci_run` and `ci_get`, which workflow Agents also use for their Run's workspace.
Generated qualification definitions retain historical diagnostic commands and
reports; create ordinary verification Jobs from the authoring templates.

The physical acceptance file is
`apps/api/test/job-verification-qualification.acceptance.test.ts`. Its protected
inputs are `FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION`,
`FOREMAN_CODE_VERIFICATION_QUALIFICATION_PROFILE` and
`FOREMAN_CODE_VERIFICATION_QUALIFICATION_QUEUE`. These identify an installed
image, offline seed, actual enforced quota pool and approved source/profile
configuration. Run it through the root acceptance runner on the approved host.
It also exercises authenticated MCP denial, creation, execution, cancellation and
persisted report readback. Fixture tests do not establish physical qualification.

Installer capture is covered by
`apps/api/test/installed-verification-runtime-capture.acceptance.test.ts`, using
`FOREMAN_CODE_VERIFICATION_QUALIFICATION_CAPTURE_INPUT` and the protected profile
input. It reads actual kernel quota state, hashes the selected binaries and seed,
and checks metadata restoration after host restart. It does not substitute a
quota observation or mutate the installed seed.

Single-device physical qualification belongs to Phase 2. The two-computer
Codex-to-Codex gate belongs to Phase 5. Claude two-computer cases remain
untested. Provider credentials stay on their original computers; real Claude
qualification or acceptance turns explicitly use `claude-haiku-4-5-20251001`.
