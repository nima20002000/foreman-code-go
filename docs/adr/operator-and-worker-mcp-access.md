# ADR: Operator and Worker MCP access

- Status: Accepted for Operator MCP v1
- Date: 2026-09-15
- Scope: NIM-2579 through NIM-2587

## Decision

The API process owns two logically separate MCP domains:

- `/mcp/operator` is the authenticated product-management interface delivered by this wave.
- `/mcp/tools` is reserved for a future Worker Tools MCP. It is not mounted by Operator MCP v1.

Both domains may reuse transport helpers, deterministic authorization, audit infrastructure, and application services. They have separate registries and credential audiences. Splitting endpoints is defense in depth; it is not operating-system isolation and does not replace authorization.

Browser HTTP routes and Operator MCP tools call the same application services. Services own authorization, product rules, and transaction coordination; repositories own PostgreSQL persistence; MCP and HTTP handlers only validate, establish caller context, invoke a service, and validate/map the result.

## Authority and grants

Caller identity comes only from a validated credential. A supplied agent ID, role, node, prompt, skill, label, or model-generated confirmation cannot establish identity or grant authority.

Operator, Researcher, Developer, and Reviewer are permission templates or display labels, not runtime authority. Ordinary board agents have no Operator MCP access by default. An owner may explicitly grant a compatible principal access to either or both MCP domains with action and resource scope. A worker-only credential cannot authorize Operator calls.

Authorization is deny-by-default and evaluated for tool discovery, every invocation, every target resource, and each operation in an atomic graph batch. Scope follows authorized workspace, workflow, run, and resource relationships. A principal cannot issue credentials, grant itself privileges, or silently delegate its grants.

Accepted policy references may be pinned for reproducibility, but live expiration, revocation, and narrowed permissions override snapshots. Broader access requires a fresh owner-authorized grant.

## Native harness boundary

Application permissions do not replace Codex/OpenCode sandbox, filesystem, network, or native tool controls. Native harness tools remain available only under those independent controls.

Future board-agent MCP delivery must use supported per-session native MCP configuration, bind the credential to the accepted execution identity, and isolate credentials between concurrent executions. Credentials must not be written to global CLI configuration, prompts, graph JSON, logs, or unrelated child-process environments.

## Implemented now versus deferred

Operator MCP v1 implements scoped local Operator credentials, authenticated management tools, shared application services, durable drafts, command receipts, and management audit.

Deferred work includes the Worker Tools MCP, board settings for assigning MCP access, runtime credential injection into Codex/OpenCode sessions, public OAuth interoperability, memory, Files, Kanban, browser services, scheduling, remote runners, and a full Operator chat UI. No empty Worker endpoint or non-functional board access toggle is added.

## Consequences

Local credentials are intentionally preconfigured and revocable; they are not described as universal OAuth support. Public or remote deployment will require a standards-compliant OAuth resource-server and identity-provider integration.

Management mutations use stable command identities and transactionally stored receipts. Replays reconcile safely, but a receipt is not a claim of exactly-once external side effects. Run Start persists acceptance before asynchronous execution, while Stop reports acceptance separately from confirmed process termination.
