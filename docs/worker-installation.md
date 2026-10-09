# Selected-main Ubuntu worker

## Main execution setting

Main defaults `FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED` to `0`. New workflow Agent steps
and Jobs on connected Worker computers, including laptop execution, are disabled.
Main execution remains available, as do existing history, reconciliation,
cancellation and cleanup. Pairing a computer does not enable execution.

A person may set `FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED=1` in Main's startup environment
and restart Main after qualifying the intended Worker. Activation is human-only
because it permits execution on another computer; neither HTTP nor Operator MCP
can change the deployment environment. Normal placement, permissions, source and
runtime qualification checks still apply when the setting is enabled.

Settings > Computers shows the active value on the Main card ("Worker execution").
Authenticated readers with global `settings:read` can read the same value through
Operator MCP's `worker_execution_settings_get`, which returns
`{ enabled, managedBy: 'startup' }`.

`apps/worker` is a worker-only composition. It loads W07 identity/pairing and
starts the W07 connection supervisor. It does not import API startup, PostgreSQL,
migrations, owner setup, workflow recovery or the schedule dispatcher. Dispatch
and transfer remain disabled. A connection does not establish execution authority.

The artifact also includes `src/worker.mjs`, a pure worker factory module. Its
`createWorkerConnection` export accepts B's actual `extensions` registrations;
`startConfiguredWorker({ stateDirectory, extensions })` performs the same
runtime/persistence checks as the CLI and returns the worker handle with B's
`request` and `capabilities` methods on `handle.connection`. Root/HRT-C supplies
the real domain handlers and grants. No empty dispatch handler or dynamic plugin
loader is installed by this package. The CLI accepts no caller-provided extensions.

The worker also loads `approved-roots.json` from its private state directory when
present. This exact shared W09 allowlist is human-only configuration because it
expands the worker's filesystem scope. Main HTTP/MCP operations may select an
approved base and relative folder; they cannot supply an allowlist, arbitrary
absolute path, or modify this file. No configured allowlist means no root handler.

After the explicit root/install approval gate, the exported read-only
`qualifyApprovedRootAllowlist` helper can record approved canonical base/runtime
paths and their filesystem identities. Persist the reviewed result as an
OS-user-owned private 0600 file, separate from versioned app code. This workstream
does not create or approve real roots, change filesystem modes, or write that
configuration on a laptop. Root paths must already exist and be persistent.

Startup binds the file to the selected main/device/installation, verifies every
approved inode/mount identity without refreshing mismatches, and registers the
actual W09 `workspace-roots-v1` attestation/browse/source-namespace handler through
W07's authenticated channel. Each request checks its current boot, connection,
key/authorization revisions and approved base/access scope before reading the
allowlist or target filesystem. Changed config is re-read and fenced; additions
require an approved restart to negotiate the startup scope. Updates/rollback keep
the file in persistent state. Doctor does not disclose these private paths.

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
are not qualification of the laptop. Packaging is qualified only for Ubuntu x64
with glibc and an explicitly qualified Node 22 runtime. ARM64 packaging is not
supported; its Sharp assets and quota helper have not been qualified.

The target and optional runtime metadata must be committed JSON files under
`apps/worker/artifacts/`. Review the bytes at the captured source commit, for
example with `git show HEAD:apps/worker/artifacts/ubuntu-24.04-x64-target.json`.
External files and uncommitted new files cannot be build inputs. Working-copy
edits to an existing target are not selected: the builder reads the committed
bytes. Commit and review the target first, then build that revision. By default
the captured revision is HEAD; `WORKER_BUILD_COMMIT` selects a reviewed full
commit SHA. Build-control files must also match that revision.

```
corepack pnpm --filter @foreman-code/worker build:artifact apps/worker/artifacts/ubuntu-24.04-x64-target.json /new/artifact-directory
```

The fresh output includes the built worker, installer, service template and a
manifest listing every shipped file's size/SHA-256, exact target/runtime,
protocol/identity formats, commit and lockfile hashes. The builder rejects
control-plane imports and external non-Node runtime imports. Review and approve
the manifest SHA-256 through a trusted channel before transferring the artifact.
An accompanying untrusted checksum file is insufficient.

The manifest version is the captured product release version from the root
package, so releases can be ordered even when the worker package version stays
the same. An update with a different source commit and an unchanged release
version is rejected because its release order is unknown. Existing artifacts
that used the worker package version do not establish product release order;
their version fields are not rewritten or treated as proof of a newer release.

## Human installation gate

Approve exact OS user, Node path, app directory, state directory, artifact hash,
service configuration and selected-main TLS/listener trust before installation.
App versions and state must use separate private 0700 directories. State holds
0600 local identity and pairing; it survives restart/update/rollback. Do not copy
owner sessions, DB secrets, provider login files or MCP credentials.

Node executable provenance is a human installation gate. Reconcile the approved
path and executable digest with the reviewed runtime metadata before running
the installer. The installer checks the reported OS, architecture, libc and Node
version; it does not authenticate the executable's provenance or silently
install a runtime.

Installation, local pairing and OS user-service activation are human-only
because they select private filesystem paths, credentials and the user's service
manager. Operator MCP cannot approve those machine-local changes or select a Node
executable. Its existing CI policy, qualification and execution tools continue
to use explicit grants; Companion's session confirmation is not an MCP grant.

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
It never emits the private key. Create a main-authorized grant for that installation
and save a private 0600 enrollment input containing `mainId`, the human-approved
`mainPublicKeyFingerprint`, WSS `/device/connect` endpoint, grant and stable UUID
`requestId`. Keep the same request ID when retrying a lost response.

```
/absolute/node /private/app/current/src/cli.mjs pair --state /private/state --enrollment-file /private/enrollment.json
```

Pair first verifies a fresh nonce-bound proof from the pinned application main
key over normal verified HTTPS, then sends the signed enrollment grant. It
validates registration against the local identity and uses A's write-once
persistence API. Output contains public IDs/revision only. It cannot overwrite
an existing pairing or silently select a new main; an endpoint edit is not
re-pairing. Remove the grant input through the human's approved cleanup policy.

## Update, rollback and diagnostics

Before updating, human-approved W08 drain/stop policy must complete and the
worker service must be stopped. Pass `--approve-stopped-update yes` to install
only after that gate. Without approval updates fail closed. A kernel-owned
abstract socket rejects duplicate start and active-worker updates without using
stale PID files or broad process-name kills. Missing runtime/OS/arch/libc or
unknown protocol/identity formats are rejected. Silent downgrades are rejected.

New installations record the canonical state directory in private
`state-directory.json` under the app root. Every update, rollback and Companion
service plan must use that same state directory. An existing root without this
record fails with `installation_state_unbound`: supplying another unlocked state
directory cannot authorize replacement. Such installations require a human to
review the original service's app/state paths and drain/stop it, then retain the
old app directory and perform a fresh approved installation into an empty app
root with the original state. Do not fabricate the binding or delete state to
get past the check.

The installer serializes with an app-owned lock directory, verifies the approved
manifest and all copied bytes, fsyncs staged files and every containing directory
from children to parents, persists newly created installation-root ancestors,
and atomically changes
`current`. `previous` retains the last version. Full disk/read-only errors before
publication leave `current` intact. A process killed during staging can leave an
app-owned `.stage-*` and `.install-lock`; after confirming no installer is active,
a human may remove only that identified staging/lock. There is no unsafe automatic
stale-PID cleanup. Retry of the same installed manifest is idempotent.

Setup retains the installation and worker-state locks while publishing the MCP
bridge, Companion launcher, desktop files and proposed service. Companion service
activation shares that installation lock through user-manager commands. Generated
launchers and service units reference the reviewed immutable release directory.
If an open Companion's installed manifest changes, it disables its actions and
asks the user to reopen the installed launcher.

For the default Companion directories, update with the incoming approved
artifact's `setup` command and `--approve-stopped-update yes`, using its approved
Node runtime. The lower-level `install` command updates the release tree only;
after using it, rerun `setup` from that artifact to refresh the launcher and
proposed service before reopening Companion.

```
APPROVED_RETAINED_NODE /private/app/current/src/install-cli.mjs rollback --root /private/app --state /private/state --approve-stopped-update yes
/absolute/node /private/app/current/src/cli.mjs doctor --state /private/state
```

Rollback verifies retained manifest/files before switching and preserves state;
it does not downgrade identity format. Before running the example, inspect the
retained manifest in `/private/app/previous/manifest.json` and replace
`APPROVED_RETAINED_NODE` with a separately approved executable matching its
`target.node`. A target update does not imply that the current Node can run the
previous release. No Node is automatically selected or installed. After rollback,
rerun the retained release's approved setup with that runtime to republish its
launcher and proposed service, then review and confirm the service plan before
starting it. For a custom app root, render and review its service with the retained
runtime instead. Doctor is read-only and emits only OS,
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
