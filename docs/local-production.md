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

The installer replaces the existing `graphql-operator-api.service` dev command
with the compiled production API, adds `graphql-production-db.service`, and enables
both at user login. The API restarts on failure; Docker restarts crashed PostgreSQL
containers. Docker itself must start at boot. Graphical-session autostart waits for
the services and opens an app window in the owner's existing Chrome session. The
application menu has a **graphql** launcher, with the same SVG used for its desktop
icon, browser favicon, web manifest, and the Companion launcher. Chrome remains
owned by the user; closing its window does not stop the API.

This installer creates no browser account or login secret. Integrate the implicit
local-user change before verifying ready-to-work startup. MCP still requires its
existing bearer credentials, roles, grants, and harness security. Host installation
is an OS-user operation, outside Operator MCP. Production harness qualification
and rollout restrictions remain in effect.

Production storage is independent of development and tests:

| Resource | Production location |
| --- | --- |
| PostgreSQL | `127.0.0.1:55440`, database/user `graphql_production` |
| Compose project | `graphql-local-production` with `compose.production.yaml` |
| Docker volume | External `graphql-production-postgres` |
| Credentials | `~/.config/graphql-production/production.env` (0600) |
| Workspaces/uploads | `~/.local/share/graphql-production/{workspaces,files}` |
| Runs/MCP routes/cache | `~/.local/state/graphql-production/{runs,mcp,cache}` |
| Releases | `~/.local/lib/graphql-production/releases/`, selected by `current` |
| API logs | `~/.local/state/graphql-production/logs/` (rotating, bounded) |

PostgreSQL uses its durable defaults, including fsync, synchronous commit, and
full-page writes. The production password stays stable across updates. Preserve
`production.env` with database backups; installation refuses to generate another
password if that file is missing while the production volume exists. No production
credentials are written into repository `.env` files or test configuration. Normal
tests connect to a different port and role; `db:down` uses a different Compose
project and volume. Even production Compose `down --volumes` retains this external
volume. Back up the database and workspace/upload files before updates.

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

To disable desktop autostart, remove
`~/.config/autostart/graphql-production.desktop`. To stop and disable the backend,
use:

```sh
systemctl --user disable --now graphql-operator-api.service graphql-production-db.service
```

These actions retain production data.
