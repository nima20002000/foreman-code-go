# NIM-2856 trusted device setup

Baseline: clean integration_validation b17b513c, isolated resume_device_setup.
Owned files: apps/api/src/modules/devices/trustedConnectionSetup.ts,
trustedConnectionProbe.ts, trustedConnectionManagement.ts,
trustedConnectionSetup.test.ts, trustedConnectionProbe.test.ts,
trustedConnectionManagement.test.ts and this document. No shared schema,
manifest, migration, factory, UI or rsync adapter edits.

Typed interface (server composition, not a second identity):
- discoverTrustedConnectionHost(): local selected OS user, installed executable
  versions, LAN candidate IPs, optional actual Tailscale self endpoints/state.
- probeTrustedConnection(endpoint): bounded, read-only strict SSH diagnostics;
  observed SSH host-key SHA256, OS username/UID and remote executable versions.
- PostgresTrustedConnectionSetup.read/check/configure: current existing device
  registration plus revisioned consent receipt using original command receipts,
  live management authority and transaction locks. configure requires a supplied
  verifyOwnerApproval SQL callback bound to the full input. It is fail-closed
  without that approved application composition. settings:update is not consent.
- registerTrustedConnectionRoutes/Tools: equivalent authenticated HTTP/MCP.

Integration owner must compose the approval verifier and mount registrars; shared
contracts owner must publish the schema for W12 web consumption. No shared-service
restart or source edits outside these files are authorized for this lane.

## Required composition

`verifyOwnerApproval(client, principal, input, registration)` returns
`Promise<{ ownerId: string }>` from the existing trusted human approval receipt,
and must consume/verify it atomically, bound to the complete configure input.
The service records that human identity, not the invoking Operator agent.
It has no permissive default verifier and no in-memory production consent store.
The configure transaction uses original command/audit receipts and device locks;
CAS prevents parallel configure commands from overwriting consent. Old command
replay returns its original receipt but never replaces the latest consent. Device
revocation/re-pair/key changes fence readiness before SSH and again afterward.

The registrars export five HTTP paths under `/api/devices/connection-*`:
GET host, POST read/inspect/check/configure. Matching MCP names are
`device_connection_host_discover`, `device_connection_read`,
`device_connection_inspect`, `device_connection_check`,
`device_connection_configure`. Use the existing bearer/cookie authenticator and
capability discovery. Both interfaces share service/schema/permissions. Integrator
must add the tool requirements to existing Operator capability discovery and
publish these server-local schemas in shared contracts before W12 UI uses them.
No production registrar mount or capability export is claimed by this lane.

Flow: existing installed companion and key-bound enrollment -> existing paired
DeviceRegistration -> discover local install prerequisites/endpoints -> inspect
owner-selected endpoint/user -> obtain action-specific human approval binding the
observed SSH host key and paired identity -> configure -> check -> select ready
device. Missing tools require an approved installation; this code never executes
installation/network/key commands. Revocation persists allowOwnerCommands=false.
There is no generic remote shell endpoint. Every future execution caller still
needs its own current domain and harness permission checks, action-time authority,
and same revision/host/user fences; a ready snapshot is not execution admission.
OS user/root selection is explicit in the approval; no automatic sudo/root.

## Actual host checks

Sanitized evidence outside Git:
`/home/user/Desktop/graphql-worktrees/_orchestration/resume-20261001/device-setup-readiness.json`.
PC user user UID1000: OpenSSH10.2p1 Ubuntu-2ubuntu3.6, rsync3.4.1,
Tailscale1.102.4 Running. PC LAN192.168.88.197 and Tailscale100.64.0.22
are observed self candidates; bridge/private interface candidates do not imply
routability. Builder strict SSH at100.64.0.20 succeeds as builder UID1000,
OpenSSH9.6p1 Ubuntu-3ubuntu13.19 and rsync3.2.7. LAN192.168.88.254 SSH
check times out and returns offline. Host-key SHA256 is retained in sanitized
local evidence. Same physical LAN; no real cross-network test. Version presence
is not patch or native harness qualification. No live approval/credentials/grants,
SSH/router/VPN/service settings or known_hosts changed.

Remaining integration proof: real app human consent receipt, mounted authenticated
HTTP/MCP denial/audit/persisted readback under PostgreSQL, W12 UI, actual distinct
network reachability and full application Run/artifact acceptance. Integration
executor alone owns shared services and physical mutation scenarios. Keep issue
In Progress / To verify; source and primitive success do not close acceptance.

## Focused verification

Pinned offline frozen dependency install and contracts build passed. Final three
suites:35/35 cases; API tsc --noEmit and six owned-file ESLint passed. Final human
approver identity correction:13/13 service cases, API tsc and two changed-file
lint passed. Logs: device-setup-final.log and device-setup-owner-identity.log in
_orchestration/resume-20261001. These use a mocked SQL boundary, Fastify injection
and real in-memory MCP SDK transports, not PostgreSQL or full app acceptance.

Scheduler inspection requested by parent: all five heavy invocations explicitly
used require_escalated and unchanged scheduler; contracts build was nested inside
the outer scheduler. All returned exit0. No remaining owned scheduler/test process
was found. No peer process/slot was killed or queue state manually modified.
Actual escalation inspection namespace:pid:[4026531836],mnt:[4026531832].
Root-owned /proc/1/ns/pid was inaccessible; no assertion about its namespace.
Sanitized invocation evidence: device-setup-scheduler-evidence.json.

The diagnostic deliberately reports the actual PATH rsync3.2.7 on Builder. Parent
reports app-private patched rsync3.5.1 available; the rsync adapter/integration
owner must supply its explicit verified binary selection. This diagnostic does
not certify the system rsync as approved for transfers or silently replace it.

## Human authority implementation (follow-up assignment)

Consumed root shared DTO commit ee0fcad5 (local prerequisite e86a6f50); core setup,
probe, consent and readiness shapes now import
`@foreman-code/contracts/trusted-device-connection`. Do not cherry-pick the borrowed
shared commit again.

New owned `trustedConnectionHumanAuthority.ts` and its focused test implement the
previous missing verifier. Compose:

```ts
const authority = new PostgresTrustedConnectionHumanAuthority(pool, mainId)
const setup = new PostgresTrustedConnectionSetup(pool, mainId, {
  verifyOwnerApproval: authority.verifyOwnerApproval,
})
registerTrustedConnectionApprovalRoutes(app, authority)
```

These four approval routes require `requireLocalHuman(request)` plus live
unscoped settings authority and exact `local_human_principal` principal mapping:

- POST `/api/devices/connection-approvals`: `{requestCommandId, action}`;
  action is TrustedConnectionConfigure without approvalId. Server issues ID,
  captures exact paired registration and original five-minute expiry.
- GET `/api/devices/connection-approvals/:approvalId`: exact request plus derived
  pending/approved/consumed/expired/stale/revoked state and decision timestamps.
- POST `.../:approvalId/approve`: `{commandId}`. Human decision covers the saved
  immutable action, not caller-replaced fields or a generic allow checkbox.
- POST `.../:approvalId/revoke`: `{commandId}`. Withdraws an unused request or
  approval; does not claim to reverse a previously consumed configuration.

Configuration input is the readback's full `action`, including server-issued
approvalId and the original configure commandId. Request and decision command IDs
are separately idempotent. Request retries retain original ID/expiry and derive
current state. Human-only receipt issuance/decision is intentionally unavailable
through MCP/bearer authentication; previously approved configuration retains the
shared HTTP/MCP service and requires the same current human-owner principal.
Settings:update alone cannot issue or consume someone else's approval.

Storage uses four connection-specific immutable management command operations
(approval.request/approve/revoke/consume) and an approval advisory lock, with
existing command audit and existing receipt table. No migration, Job receipt,
secret token, new credential or SSH/network change. Consumption writes through
the caller's configure SQL transaction, so consent failure rolls it back. Exact
full action and registration hashes, owner mapping, live grants, original expiry,
current consent revision and original human decision are rechecked. A consumed
receipt cannot be used again; configure command retry returns its original result
through the original coordinator without consuming twice.

Root published the four approval DTO schemas/types in e195a767. Mount routes
behind the existing verified
browser/CSRF authenticator, add actionFor permissions/capability descriptions, and
run actual PostgreSQL/browser tests. Source tests mock SQL transactions and verify
browser-only Fastify helpers; they do not claim authentic browser-session or real
SQL concurrency proof. Real inherited host scheduler namespace/token evidence:
`device-setup-authority-scheduler-evidence.json`;52 focused cases + API types and
owned lint passed before the final extra expiry/agent-consumption regression.

## Explicit delegated Operator apply (parity fix)

Parent approved a minimal optional exact delegate binding. Failing-before evidence:
`device-setup-delegated-before.log` shows the eligible delegated caller rejected
in the former owner-only verifier. Ordinary owner approvals remain owner-only.
The browser owner may now explicitly select `applyPrincipalId` at request time.
Server captures optional `applyAuthority` containing principalId, audience=operator,
delegatedFromOwnerId, original conversationId and 64-character authorityHash.
No new credential or settings grant is created. No unrelated bearer is admitted.

This supported delegate is an existing direct Operator-chat credential bound by
`operator_chat_credentials` to an open, nondeleted conversation belonging to the
current browser owner. A bare delegated_from field, different role, unrelated
Operator token, nested delegation or Job/Run authority is insufficient. Both live
principal and parent authority are revalidated; effective permissions retain the
existing operatorChatGrants ceiling and must already authorize unscoped
settings:update. The stable hash covers caller/role/direct owner/conversation,
full effective grants and accepted DB expiry facts, never the current clock.
Request, browser review and consumption require the same hash. Closed chat,
changed/lost grants, revocation, expiry, wrong caller/action, changed device or
used receipt cannot consume. Receipt ownerId and consent approvedBy always remain
the actual authenticated human owner. Consumption receipt principal_id/audit
identify the applying delegate. Owner cannot substitute for a specifically bound
delegate; choose an owner-only request instead. Human issuance/review/revocation
remain browser-only. Configure and persisted readback work through the existing
Operator MCP registrar; exact retries consume once.

Root was sent exact optional shared schema declarations before implementation and
approved them. No reserved contract file was edited in this lane. Root published all approved optional binding fields in83ab70d6 (local borrowed
prerequisite11f06be0). The authority now imports shared approval exports directly;
the apply-authority alias derives from sharedReceipt.shape.applyAuthority.unwrap(),
and its type from NonNullable<sharedReceipt['applyAuthority']>. No field is
reconstructed or stripped. Root e195a767 was consumed as local prerequisite
7096472d (includes shared approval import replacement); do not cherry-pick that
borrowed commit again. UI consumption of the published shared DTO must expose explicit
selection, never select a delegate automatically or synthesize a grant.

Verification:62/62 four-file cases, API tsc and eight-file ESLint passed in
`device-setup-delegated-focused.log`. Positive delegated case uses the real
in-memory MCP SDK for configure, readback and same-command retry with mocked SQL
transaction storage. Denial cases assert exact codes and no consumption. Real
PostgreSQL/authenticated HTTP-MCP/native Operator acceptance remains integration
owner work, with no claim of live grant changes. Final extra time-stability case
is in `device-setup-delegated-stability.log`.

Shared-binding final verification: all63 cases across four suites, full API
`tsc --noEmit`, and eight owned TypeScript files' ESLint passed against committed
root83ab70d6 via the unchanged host scheduler. Log:
`_orchestration/resume-20261001/device-setup-delegated-shared.log`.
No approval binding field mismatch was found. Shared publication is complete;
production composition/UI and actual PostgreSQL/browser/MCP acceptance remain
integration-owner verification, with no live credentials/grants altered here.
