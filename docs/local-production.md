# Local production on Linux

From a desktop session, with Node 22+, the pinned Corepack/pnpm runtime, Docker
Compose, user systemd, and `/usr/bin/google-chrome` installed:

```sh
corepack pnpm production:install
```

Use the same command to update. It installs dependencies under the release-age
policy, builds, stages a standalone release, stops the API, migrates the production
database and checkpoints, switches the installed release, restarts the API, waits
for readiness, and opens Chrome at **http://127.0.0.1:3041/workspaces**.
Build or packaging failures happen before the API is stopped. A migration failure
leaves the API stopped: inspect the error, fix it, and rerun the command. Releases
are retained for recovery; database migrations are not automatically rolled back.

The API serves the built web app on the same origin. There is no Vite server or TS
loader at runtime. Each release includes its Node executable, compiled API,
production dependencies, contracts, web assets, and the existing MCP bridge.
Services do not depend on the source checkout remaining on disk.
Staging restores the source workspace's full frozen dependency installation after
production deployment, including a failed deployment. Later workspace commands
can run non-interactively without being switched to production-only dependencies.

The installer replaces the existing `graphql-operator-api.service` dev command
with the compiled production API, adds `graphql-production-db.service`, and enables
both at user login. Database activation and the API retry failures independently,
so an initial Docker or PostgreSQL startup failure recovers without another login
or manual API start. Docker restarts crashed PostgreSQL containers. Docker itself
must start at boot. Graphical-session autostart waits for
the services and opens an app window in the owner's existing Chrome session. The
application menu has a **Foreman Code** launcher, with the same SVG used for its desktop
icon, browser favicon, web manifest, and the Companion launcher. Chrome remains
owned by the user; closing its window does not stop the API.

This installer creates no browser account or login secret. Integrate the implicit
local-user change before verifying ready-to-work startup. MCP still requires its
existing bearer credentials, roles, grants, and harness security. Host installation
is an OS-user operation, outside Operator MCP. The installer selects
`FOREMAN_CODE_LOCAL_PRODUCTION=1` (legacy `GRAPHQL_LOCAL_PRODUCTION=1` remains supported): loopback production enables local harnesses through
the same provider, account, model, approval and sandbox qualification used at
every execution admission. Explicit harness disables remain in effect. Other
production deployments retain their rollout restrictions.

Production storage is independent of development and tests:

| Resource | Production location |
| --- | --- |
| PostgreSQL | `127.0.0.1:55440`, database/user `graphql_production` |
| Compose project | `graphql-local-production` with `compose.production.yaml` |
| Docker volume | External `graphql-production-postgres` |
| Credentials | `~/.config/graphql-production/production.env` (0600) |
| Operator settings | `~/.config/graphql-production/operator.json` (0600) |
| Workspaces/uploads | `~/.local/share/graphql-production/{workspaces,files}` |
| Runs/cache | `~/.local/state/graphql-production/{runs,cache}` |
| Managed MCP launcher/routes | `~/.local/share/graphql/mcp/` (shared launcher; credential-scoped routes) |
| Releases | `~/.local/lib/graphql-production/releases/`, selected by `current` |
| API logs | `~/.local/state/graphql-production/logs/` (rotating, bounded) |

The service uses the existing reviewed native MCP launcher so upgrading does not
rewrite native connections or their tool, approval and disabled policies. Its
shared routing index contains only credential digests, loopback endpoints,
expiry times and app process IDs. Each credential routes to its issuing app;
the endpoint still validates its grants and scope. Production database, files,
workspaces and execution state remain separate from development and tests.

The Jobs view and Operator MCP use the same persistent build queue in this
installation. Its reviewed Main configuration belongs at
`~/.local/state/graphql-production/runs/job-queue.json`, under the configured
`HARNESS_WORKSPACE_ROOT`. The owner supplies a private 0600 file with the shared
`JobBuildQueueConfigurationSchema`, the installation's Main ID, reviewed limits
and resource envelopes. Queue review is owner bootstrap metadata; Operator MCP
cannot supply or approve it. The installer preserves this runtime directory
across updates and does not create queue limits, resource allowances or approvals.
Restart the API after changing the configuration. Saved requests, original
deadlines, selections and reservations remain in the production database;
startup reconciles those attempts and keeps capacity until confirmed closure.

PostgreSQL uses its durable defaults, including fsync, synchronous commit, and
full-page writes. The production password stays stable across updates. Preserve
`production.env` with database backups; installation refuses to generate another
password if that file is missing while the production volume exists. No production
credentials are written into repository `.env` files or test configuration. Normal
tests connect to a different port and role; `db:down` uses a different Compose
project and volume. Even production Compose `down --volumes` retains this external
volume. Back up the database and workspace/upload files before updates.

Updates preserve operator settings in `operator.json`, a JSON object of environment
variable names and string values. Existing settings in `production.env` are copied
there on the first update. Migration reads the same systemd quoting as service
activation, preserving quotes, backslashes and multiline values. Edit
`operator.json`, then rerun the installer. Binary
overrides, harness rollout choices and API/database timeouts are validated before
activation. Host, ports, database credentials, storage isolation and other
installer-owned settings stay in `production.env`; do not edit that generated file.
One OS file lock serializes the complete installation, including migration,
activation and readiness. Readiness verifies the database installation identity
and selected compiled release before opening Chrome.

Native harnesses use the desktop user's existing login files. The service keeps
that user's `HOME`; without explicit XDG overrides, OpenCode reads its normal
`~/.local/share/opencode/auth.json` and `~/.config/opencode` configuration. The
installer keeps its cache separate and does not copy login files or change
harness sandbox permissions.

For an environment-based provider credential, explicitly add the provider's
variable, such as `OPENROUTER_API_KEY`, as a string in private `operator.json`,
then rerun `production:install`. This is an OS-owner setting, outside Operator
MCP; the file and generated service environment remain 0600. Provider credentials
reach native subprocesses, while database credentials and unscoped application
tokens are excluded. Never put credentials in the checkout or qualification logs.
An HTTP 401 from a particular provider requires fixing that provider's native
login or explicit credential; qualification remains required. Supported model
selection through Settings or revision-checked `harness_defaults_update` MCP
does not authenticate another provider or bypass its qualification.

Operations:

```sh
systemctl --user status graphql-operator-api.service graphql-production-db.service
journalctl --user -u graphql-operator-api.service -u graphql-production-db.service -f
curl --fail http://127.0.0.1:3041/health/ready
"$HOME/.local/lib/graphql-production/graphql"
```

Cold-start check, without rebooting the desktop:

```sh
systemctl --user stop graphql-operator-api.service graphql-production-db.service
"$HOME/.local/lib/graphql-production/graphql"
curl --fail http://127.0.0.1:3041/health/ready
curl --fail http://127.0.0.1:3041/workspaces
```

In Chrome, verify the dashboard opens without login and that launcher/taskbar and
UI icons render. Confirm saved workspace data survives the cold start. Verify
`ss -lnt` shows only `127.0.0.1:3041` and `127.0.0.1:55440` for this installation,
and the API process runs `dist/server.js`. To verify API crash recovery, kill only
the service's main process, then check readiness and the new MainPID:

```sh
systemctl --user kill --kill-whom=main --signal=KILL graphql-operator-api.service
```

After installing and configuring qualified native profiles, run the installed
service regression through the heavy-job queue:

```sh
corepack pnpm test:production:installed
```

This uses the installed compiled release and authenticated Operator MCP. It also
checks configuration migration and updates against actual systemd environment
values in a temporary service. It tests
an Operator reply, Codex/OpenCode workflows, denied callers, native cancellation,
a failed first database activation followed by automatic recovery, a production
PostgreSQL container restart, and recovery after killing the API's
main process or the entire service during native work. After service-wide SIGKILL,
it stops through MCP and verifies cleanup after another restart. Kernel removal of
an empty native cgroup can confirm closure even when SIGKILL prevents an exit
receipt; recovery requires the original parent and guardian to have exited and
verifies the full, unchanged cgroup hierarchy. It verifies persisted readback and
unchanged native execution/session bindings. It archives its own workspace and revokes its
credentials; conversation and run history remain available for inspection. Run it
when no personal work is active because the recovery checks restart services.
The API unit delegates its cgroup subtree to native guardians and restarts after
both failure and unexpected clean shutdown. An explicit systemd stop stays stopped.

To disable desktop autostart, remove
`~/.config/autostart/graphql-production.desktop`. To stop and disable the backend,
use:

```sh
systemctl --user disable --now graphql-operator-api.service graphql-production-db.service
```

These actions retain production data.
