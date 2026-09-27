# Operator MCP v1

Operator MCP is the authenticated local product-management interface delivered by NIM-2579 through NIM-2587. It runs inside the existing API process at `POST /mcp`, the one GraphQL MCP endpoint that also serves workflow agents; an Operator credential selects the Operator role. See [`graphql-mcp.md`](./graphql-mcp.md).

The transport uses MCP protocol `2026-07-28` with the official TypeScript SDK packages `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/fastify`, and the acceptance-test `@modelcontextprotocol/client`, all pinned at `2.0.0`. The packages require Node 20 or newer; this repository requires Node 22. The published packages use Zod 4-compatible standard schemas. Their July 27, 2026 publication date satisfies the repository's strict 48-hour package-age policy.

## Start and migrate

```sh
corepack pnpm install
corepack pnpm db:up
cp apps/api/.env.example apps/api/.env
corepack pnpm dev:api
```

API startup applies the application migrations, including principals, command receipts, management audit, revisions, archive state, durable graph drafts, and workspace execution locations. Existing workspace, workflow, agent configuration, run, execution, and activity records are retained. Existing workspaces migrate with no configured execution location, and historical runs do not receive invented paths.

The API remains loopback-bound by default. Operator HTTP and MCP requests validate Host and Origin. Public deployment and OAuth interoperability are out of scope for this local credential mode.

## Issue and revoke credentials

Credential issuance and revocation are trusted local owner commands; neither is an MCP tool. The plaintext token is displayed once and only its SHA-256 digest is stored.

```sh
corepack pnpm --filter @graphql/api credential issue --name local-owner --days 30
corepack pnpm --filter @graphql/api credential issue --name workspace-operator --days 7 --workspace workspace-1
corepack pnpm --filter @graphql/api credential revoke principal-UUID
```

The optional `--audience worker` flag creates a Worker-audience credential. At `/mcp` it is limited to the Agent tools of its bound role; it cannot call Operator tools.

To enroll the browser, open Settings and paste the one-time-visible token into Operator access. The API validates it and sets a SameSite Strict, HttpOnly cookie. The token is not written to Vite configuration or localStorage. Real mode is enabled with:

```sh
corepack pnpm dev
```

## Client configuration

Use an environment variable for the token; do not place a literal credential in a checked-in file.

The managed **Add GraphQL MCP** preset in Harness Settings is the normal setup. For a fixed manual entry, Codex CLI `0.154.0` supports Streamable HTTP and an environment-backed bearer token:

```sh
export GRAPHQL_MCP_TOKEN='token-shown-by-the-issue-command'
codex mcp add graphql \
  --url http://127.0.0.1:3000/mcp \
  --bearer-token-env-var GRAPHQL_MCP_TOKEN
```

OpenCode CLI `1.18.31` accepts a remote MCP URL and header. For isolated qualification, create a temporary config and set both `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`; do not use `opencode mcp add`, which writes the installed v1 CLI's global config. Environment substitution keeps the credential out of the file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "graphql": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:GRAPHQL_MCP_TOKEN}"
      }
    }
  }
}
```

```sh
OPENCODE_CONFIG=/path/to/temporary/opencode.json \
OPENCODE_CONFIG_DIR=/path/to/temporary/config-dir \
opencode run --pure --model opencode-go/deepseek-v4.1-flash \
  --variant max --agent build 'Use the Operator MCP capabilities tool.'
```

## Tool catalog

- Context: `operator_get_capabilities`
- Harnesses: `harness_list`, `harness_get`, `harness_defaults_update`
- Workspaces: `workspace_list`, `workspace_get`, `workspace_create`, `workspace_update`, `workspace_archive`, `workspace_batch_archive`, `workspace_location_validate`, `workspace_location_set`
- Workflows: `workflow_list`, `workflow_get`, `workflow_create`, `workflow_update`, `workflow_archive`, `workflow_batch_archive`
- Agents: `agent_list`, `agent_get`
- Graph: `graph_draft_open`, `graph_draft_get`, `graph_draft_apply`, `graph_validate`, `graph_save`, `graph_draft_discard`
- Runs: `run_list`, `run_get`, `run_events_list`, `run_start`, `run_stop`

Tool discovery is caller-specific. Every call rechecks the live credential, audience, action, and resource scope. MCP annotations are descriptive client hints and never authorization. Host-path inspection and updates use the separate `workspace_locations:read`, `workspace_locations:validate`, and `workspace_locations:update` grants; ordinary workspace read/rename authority does not grant them.

## Workspace execution locations

Each executable workspace owns `{ runnerId, rootPath }` plus a location revision. Only the stable local runner ID `runner-local` is supported in this release. Validate and save an existing directory in Workspace Settings or with `workspace_location_validate` followed by `workspace_location_set`. Validation runs in the API process on the runner machine, resolves symlinks, stores the canonical destination, checks directory access, and never creates, moves, deletes, changes permissions on, or runs hooks inside the selected folder.

New runs require the current location revision. Start atomically stores the exact saved workflow version, canonical runner directory, location revision, directory identity, and accepting authority with the Run. A settings change affects future runs only. Every node in an accepted run—including nodes launched later—uses that snapshot; a missing, replaced, inaccessible, or no-longer-authorized location fails explicitly without falling back to the API directory, home, or temporary storage.

The selected project directory is the harness `workingDirectory`. GraphQL scratch data remains under `HARNESS_WORKSPACE_ROOT` as a distinct `runtimeDirectory` keyed by workspace, run, node, and attempt. Project and runtime roots may not contain one another. Cleanup and cancellation never delete the selected project directory.

This establishes where native agents start; it is not a filesystem sandbox. Codex/OpenCode native permissions and future runner isolation remain separate controls. The Settings copy states this explicitly.

`graph_draft_apply` accepts strict typed agent, node, edge, execution-limit, and required-agent-count operations. A workflow may declare `requiredAgentCount`; validation, Save, and Start then reject any graph whose number of distinct referenced agents differs. Batches and Save require the expected revision. Save creates an immutable workflow version but does not Start. Start requires that exact current saved version and the expected workspace location revision, and returns a durable Run ID before asynchronous execution.

Workspace and workflow navigation and directory lists show 5 items initially; each “Show more” request adds 10 items. MCP callers use `workspace_list` / `workflow_list` with `limit` and pass `pageInfo.nextCursor` as `cursor` until it is null. The active navigation selection can also be read directly by ID without fetching intervening pages.

`workflow_batch_archive` accepts `{ workspaceId, commandId, workflows: [{ workflowId, expectedRevision }] }` for 1–100 unique workflows. It requires `workflows:archive` for every selected workflow and removes the whole selection atomically. Missing workflows, stale revisions, or active runs reject the entire batch. Reuse the same command ID and input after an uncertain response; read back with `workflow_get` or `workflow_list`. The UI labels this operation “Delete selected” and explains history retention in its confirmation. The HTTP equivalent is `POST /api/management/workspaces/:workspaceId/workflows/batch-archive`.

`workspace_batch_archive` accepts `{ commandId, workspaces: [{ workspaceId, expectedRevision }] }` for 1–100 unique workspaces. It requires `workspaces:archive` for every selection, locks workspace admission in stable order, and checks all revisions and active runs before one atomic update. It retains workflows, history and project folders. The UI uses the same selection and confirmation flow, with uncertain retries preserving the command ID. Read back with `workspace_get` or `workspace_list`. The HTTP equivalent is `POST /api/management/workspaces/batch-archive`.

Archive retains versions, configurations, runs, results, and activity. Active work blocks archive; archive never silently cancels work. Stop reports `accepted`, `already_terminal`, or `not_owner`; an accepted request does not claim that the child process has already exited.

## Verification and limitations

`corepack pnpm test:integration` uses the official SDK client against the real Fastify Streamable HTTP endpoint and PostgreSQL. It covers the complete discovered catalog, credential audience and scope isolation, command replay/conflicts, concurrent duplicate Start, location validation and canonical persistence, stale location writes, HTTP/MCP parity, immutable Run locations, migration, batch rollback, explicit Save/Start, archive blocking, bad Origin, revocation, and legacy HTTP mutation-bypass prevention. Process fixtures—not model output—prove both adapters receive the accepted project CWD and separate runtime storage. `corepack pnpm test:acceptance` is the separately reported live Codex/OpenCode gate.

The current local credential mechanism is not OAuth. Worker Tools MCP, board-agent credential delivery, remote/public access, a full Operator chat UI, memory, Files, Kanban, browser services, scheduling, and remote runners remain deferred. See [the access ADR](./adr/operator-and-worker-mcp-access.md).

### Browser editing continuity

The Board retains its private, per-tab workflow draft and unfinished agent-settings
fields across reloads and application navigation. This recovery checkpoint is browser
interaction state, not a saved WorkflowVersion or an Operator-readable shared draft.
It does not publish edits or grant permissions. Operator authoring continues through
the authenticated shared Stage/Save/read services; browser recovery adds no MCP action.
