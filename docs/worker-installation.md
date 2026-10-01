# Selected-main Ubuntu worker

`apps/worker` is a worker-only composition. It loads W07 identity/pairing and
starts the W07 connection supervisor. It does not import API startup, PostgreSQL,
migrations, owner setup, workflow recovery or the schedule dispatcher. Dispatch
and transfer remain disabled. A connection does not establish execution authority.

## Build and approve an artifact

Build on the source-pinned main checkout after the orchestrator integrates W07-A/B
and the worker manifest. Use `corepack pnpm install --frozen-lockfile` with pnpm
11.27.0 and the existing 48-hour policy. No laptop development-stack build or npm
install is required. The artifact bundles the minimal identity and connection
closure; installation needs only the separately approved installed Node runtime.

Read-only laptop diagnostics must first identify Ubuntu release, architecture,
glibc and exact installed Node 22 version, and prove root/HOME persistence. The
historical Acer/live-session report is not current evidence. A live/overlay root
or temporary HOME blocks stable identity. Do not reinstall or wipe the OS.

An approved target JSON contains `os`, `osRelease`, `arch`, `libc`, `node`, for
example `ubuntu`, `24.04`, `x64`, `glibc-2.39`, `v22.23.2`. These example values
are not qualification of the laptop. Supported packaging targets are Ubuntu
x64/arm64 with glibc and an explicitly qualified Node 22 runtime.

```
corepack pnpm --filter @graphql/worker build:artifact /approved-target.json /new/artifact-directory
```

The fresh output includes the built worker, installer, service template and a
manifest listing every shipped file's size/SHA-256, exact target/runtime,
protocol/identity formats, commit and lockfile hashes. The builder rejects
control-plane imports and external non-Node runtime imports. Review and approve
the manifest SHA-256 through a trusted channel before transferring the artifact.
An accompanying untrusted checksum file is insufficient.

## Human installation gate

Approve exact OS user, Node path, app directory, state directory, artifact hash,
service configuration and selected-main TLS/listener trust before installation.
App versions and state must use separate private 0700 directories. State holds
0600 local identity and pairing; it survives restart/update/rollback. Do not copy
owner sessions, DB secrets, provider login files or MCP credentials.

```
/absolute/node /approved/artifact/src/install-cli.mjs install --root /private/app --state /private/state --artifact /approved/artifact --manifest-sha256 APPROVED_SHA256
/absolute/node /approved/artifact/src/install-cli.mjs service --root /private/app --state /private/state --node /absolute/node --home /approved/home --path /usr/bin:/bin
```

`service` prints a user unit for human review; it does not write, enable or start
services. Install the approved rendered unit as `graphql-worker.service` only
after approval. No command here performs sudo, creates users, enables linger,
changes power/lid/suspend settings, SSH, Tailscale, network or security policy.
The unit uses absolute ExecStart, controlled HOME/PATH, restart rate limiting,
15-second stop bound and owned service-cgroup cleanup. Browser and SSH lifetimes
do not own it. A system service requires separate approval and explicit
unprivileged User. Linger is a separate opt-in; it cannot unlock encrypted disk
or keep a sleeping laptop reachable.

Explicit application pairing writes W07-A's validated `pairing.json` using its
selected-main persistence API. The worker starts only after pairing; invalid,
expired or revoked credentials never cause automatic re-pairing. Existing
localhost browser/MCP access is not widened. No provider login is needed for
pair/negotiate/heartbeat.

`/absolute/node /private/app/current/src/cli.mjs identity --state /private/state`
initializes the durable local identity after runtime/persistence checks and emits
only its installation ID, public key/fingerprint and key revision for enrollment.
It never emits the private key. Use the main's authenticated pairing/proof flow
and W07-A's write-once pairing API; entering a new endpoint is not re-pairing.

## Update, rollback and diagnostics

Before updating, human-approved W08 drain/stop policy must complete and the
worker service must be stopped. Pass `--approve-stopped-update yes` to install
only after that gate. Without approval updates fail closed. A kernel-owned
abstract socket rejects duplicate start and active-worker updates without using
stale PID files or broad process-name kills. Missing runtime/OS/arch/libc or
unknown protocol/identity formats are rejected. Silent downgrades are rejected.

The installer serializes with an app-owned lock directory, verifies the approved
manifest and all copied bytes, fsyncs staged files, and atomically changes
`current`. `previous` retains the last version. Full disk/read-only errors before
publication leave `current` intact. A process killed during staging can leave an
app-owned `.stage-*` and `.install-lock`; after confirming no installer is active,
a human may remove only that identified staging/lock. There is no unsafe automatic
stale-PID cleanup. Retry of the same installed manifest is idempotent.

```
/absolute/node /approved/artifact/src/install-cli.mjs rollback --root /private/app --state /private/state --approve-stopped-update yes
/absolute/node /private/app/current/src/cli.mjs doctor --state /private/state
```

Rollback verifies retained manifest/files before switching and preserves state;
it does not downgrade identity format. Doctor is read-only and emits only OS,
arch/libc/Node, persistence checks, executable availability, service/user-manager
liveness, public selected-main/installation identity, pairing/connection status
and classified errors. It never prints env/auth files, keys, DSNs, process args,
journal/provider logs or tailnet inventory. A stale service record is not proof
of liveness: doctor also probes the kernel-owned worker socket.

## Remaining live evidence

Offline unit tests are not laptop acceptance. Record approved command exits,
artifact/runtime/commit/lock hashes, bounded redacted doctor output and actual
authenticated main readback. Prove stable identity after restart/update,
changed boot/connection IDs, service survival after browser/SSH closure,
reconnect and persisted revocation while SSH remains usable. Logout/reboot/power
and local provider login remain separate human gates. W08/W09 must independently
qualify remote execution and exact source transfer before advertising them.
