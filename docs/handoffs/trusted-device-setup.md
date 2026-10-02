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
`/home/nima/Desktop/graphql-worktrees/_orchestration/resume-20261001/device-setup-readiness.json`.
PC user nima UID1000: OpenSSH10.2p1 Ubuntu-2ubuntu3.6, rsync3.4.1,
Tailscale1.102.4 Running. PC LAN192.168.88.197 and Tailscale100.123.130.10
are observed self candidates; bridge/private interface candidates do not imply
routability. Dexter strict SSH at100.76.219.118 succeeds as dexter UID1000,
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

The diagnostic deliberately reports the actual PATH rsync3.2.7 on Dexter. Parent
reports app-private patched rsync3.5.1 available; the rsync adapter/integration
owner must supply its explicit verified binary selection. This diagnostic does
not certify the system rsync as approved for transfers or silently replace it.
