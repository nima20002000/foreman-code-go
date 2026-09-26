# Automatic Operator MCP routing

The managed `graphql-operator` preset installs a local stdio launcher instead of
an HTTP URL containing a port. The same installation serves Codex and OpenCode.
Use **Repair Operator MCP** in Harness Settings once to migrate an existing
fixed-URL preset; new installations use automatic routing immediately. The same
managed request/readback workflow is available through Operator MCP. Applying
a native integration remains human-only because it installs executable code and
changes harness connections; MCP cannot approve its own request. Permissions,
revisions, idempotency receipts and audit records are unchanged.

The app registers its endpoint under a SHA-256 digest of the already-issued
Operator credential. The launcher receives only `GRAPHQL_OPERATOR_MCP_TOKEN`,
looks up that exact digest and forwards requests to the owning app's loopback
`/mcp/operator` endpoint. It never chooses the first open port, scans ports, or
falls back to another instance. Registry records contain an endpoint, runtime
PID and expiration, never the token. Files and directories are owner-only.

Conversation routes are registered after credential issuance commits and are
removed on release. Existing external Operator credentials are registered by
the database's exclusive runtime owner at startup; reconciliation picks up new
or revoked external credentials. Restarting that database on another port
refreshes its routes without changing native harness configuration. A revoked
or expired credential remains denied by the authenticated endpoint even if a
route file survives an interrupted shutdown.

The setup response reports `routing: automatic` for a proven managed launcher,
or `routing: fixed` for a compatible legacy HTTP entry. Disabled entries remain
disabled. Migrating a legacy entry preserves native tool policy fields; custom
transport or authentication definitions require native configuration review.
No sandbox, grants, approval policy, or worker MCP configuration is changed.

Verification: `operator-mcp-launcher.integration.test.ts` starts two real HTTP
MCP endpoints and a stdio client, checks persisted PostgreSQL settings readback,
denied writes and revoked credentials, and changes the owning route's port
without restarting the client or changing its installation.
