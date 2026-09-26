# Worker MCP instance routing

In Harness Settings → MCP servers, use **Add Worker MCP** or **Repair Worker MCP**
for each native harness. This explicitly installs the managed `graphql-app` stdio
launcher. Repair accepts a standard local `/mcp/tools` connection using
`GRAPHQL_APP_MCP_TOKEN`; it preserves disabled state and existing tool/approval
policies. Custom and inherited entries require changes at their native source.
Existing fixed endpoints remain supported, but do not follow port changes.

The launcher selects a local app endpoint using a SHA-256 digest of the execution's
worker credential. The app registers routes only for durable worker bindings,
refreshes expiration on lease renewal, restores active routes after restart, and
removes its registered routes on shutdown. Route files contain no bearer token.
Every forwarded request still passes worker authentication, execution binding,
run/workspace scope, and tool authorization at `/mcp/tools`; no grants or sandbox
settings change. An expired, revoked, missing, or rejected credential fails closed.

The Operator can discover, request, and read back the `worker` managed preset via
`harness_mcp_servers_list`, `harness_mcp_managed_request`, and
`harness_mcp_change_get`. As with the other native MCP presets, a signed-in human
applies the request in Harness Settings; an Operator cannot approve its own
native-configuration write. Existing revision, idempotency, and audit semantics
apply. Connection changes affect new native sessions.
