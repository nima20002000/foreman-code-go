# Native subagent delivery status

This document describes the PR 57 continuation. Native observations, transport fixture tests, and live qualification are different evidence. No fixture result qualifies a provider or enables a production capability.

## Implemented local behavior

- The selected saved Run Board mounts its child overlay inside its own React Flow provider. Child selection is URL-owned. Changing Runs clears only the child fragment selection; browser history can restore the original Run and child. Unrelated URL state is retained.
- Roster permission loss removes both cached circles and the open child panel. The shared dialog supplies Escape, backdrop and focus behavior. Saved-graph keyboard guards do not block editing the child input textarea.
- Production resolves child controls through the original resident execution allocation. Run, workspace, execution attempt, agent, configured instance and accepted placement identity are checked. A replacement Run owner invalidates previously captured leases even if it retains the same manager.
- OpenCode exposes an idle-only child input transport and exact message-ID readback. Fresh native ancestry and directory checks bind the child to the admitted root, including nested descendants. No parent prompt is replayed, no child session is adopted as a workflow execution, and no session-wide cancellation is exposed as child interruption.
- Durable command retries never dispatch again. Uncertain receipts may be reconciled only by exact correlation readback under the original generation. SQL ownership locks are not held over native readback. Reconciliation is audited; missing evidence remains uncertain. Positive pre-acceptance refusal is stored as rejected.
- Background recovery failures produce bounded identity/code diagnostics without logging native prompt content. Failed tasks are drained without unhandled rejections, and later reads may retry recovery.

## Provider gates

| Provider and mode | Repository evidence | Production limit |
| --- | --- | --- |
| Codex multi-agent v2 | Package pin and installed CLI 0.154.0; existing exact-parent history adapter | Direct input is explicitly unsupported. Child interruption remains unverified and is not exposed. |
| Codex legacy collab | Capability records are version/mode specific | No reviewed exact-version child control is enabled by this continuation. |
| Claude Agent | SDK pinned at 0.3.284; existing owned-profile child-history reader | Direct child input is unsupported. No session-wide interrupt is substituted for exact task interruption. Live CLI identity and child operations still require qualification. |
| OpenCode task | SDK and transport baseline 1.18.31; existing subagent capability observations name server 1.18.33 | The new idle-input adapter does not qualify either version. The cloud build diagnostic reports the OpenCode CLI unavailable. Active input and child interruption stay unavailable. |

The SDK package version is not proof of the running server's version. Existing capability records retain `qualification: unverified`; installing an adapter must not change that. A live acceptance run must capture the exact native version, mode, installation/profile identity and operation evidence before any gate can pass.

## Remaining acceptance gates

1. Coordinate with the concurrent multi-computer/CI owner before editing remote-worker contracts, proxy, host or installed transport. The existing remote proxy does not yet carry child history or child control operations.
2. Prove cold restart/reconnection against the exact original parent and owning computer. The current production readback requires a resident admitted manager. Never create a replacement parent, resume a child prompt, or route remote work to Main as a recovery shortcut.
3. Run exact-provider live qualification. Authenticated HTTP/MCP tests using synthetic native leases prove application authorization and receipt behavior, not live provider support.
4. Complete real browser acceptance on the user's computer once connected, including nested children, paging, denied callers, supported control delivery and restart recovery.
5. Retain baseline failures separately from regressions. Do not weaken native process, filesystem, authorization or qualification checks to make this environment green.

The PR remains a draft and must not be merged as fully qualified while these gates remain open. Current execution logs and the restart handoff are maintained in the project's GraphQL Delivery Handoff Space.
