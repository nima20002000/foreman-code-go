# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Claude and OpenCode workflows across two computers remain untested. The available laptop provider logins support Codex only. Installed OpenCode workers refuse declared artifact outputs. Claude Agents run on Main only; laptops run Codex.

### Added

- Remote Orchestrator review turns on the original native session, with authenticated assignment and decision readback.
- Native artifact production, sealing, publication and Agent-to-Agent transfer for Main and installed Codex workers.
- Worker build targets for Ubuntu 24.04 and 26.04 x64 with Node 22.23.2, retaining exact OS, libc and runtime checks.
- Run CI Jobs on paired laptops: Main selects a qualified Worker, transfers the approved source and collects reports and logs.
- Mark build computers primary or backup and set how much of each computer's CPU and memory builds may use; backups take Jobs only when no primary has room.
- Place Claude Agents on Main in workflows that also run Agents on other computers.
- Workflow Agents run CI themselves: `ci_run` queues install, typecheck, lint, unit or build for their Run's workspace on the connected build computers, and `ci_get` reads the result (Operator MCP has the same tools).
- Computers settings lists each computer as a row in build order, with drag-to-reorder, Primary/Backup, builds on/off, build allowance and live CPU and memory; the sidebar shows busy computers and opens their running Jobs and Agents.
- Run CI for any commit whose dependency files match the commit a computer was qualified with.
- Computers settings shows, per computer, whether Codex, Claude, OpenCode, the GitHub CLI and Google Drive are installed and which account each is signed in to (`computer_accounts_list`).
- Sign the GitHub CLI in or out on any computer with a one-time code, from Computers settings or Operator MCP; git on that computer then uses the account.
- Give each workflow Agent its own git worktree and branch of the workspace's GitHub repository on its computer; the Run, the Board and `context_get` show the branch.
- Agent CI runs on the Agent's own computer first and moves to the next build computer in order only when its own is busy; it tests the Agent's current files, sent as a git bundle, with nothing pushed.
- Build computers prepare their own CI runtime for a commit with no human step: offline packages, verification image, profile update, protected refresh and requalification (`build_computer_prepare`, and automatically when a commit changes dependency files).
- Connect Google Drive on any computer through rclone: sign in to Google on Main, and Drive mounts at `~/Foreman Code Drive` on that computer. Agents get their workspace's shared Drive folder from `context_get`.
- Update every Agent that uses an older version of a skill, and re-save the workflows that pin them, in one click (`skill_users_update`).

### Changed

- CI qualification on a paired computer no longer needs approval: capture its installed runtime and qualify it directly in the app or through Operator MCP.
- Default new OpenCode configurations to OpenCode Go models.
- Resolve unplaced Agents to authorized Main source, root and harness choices when a workflow has an explicit remote placement; retain every accepted node placement in the Run.
- Match saved Agents and qualified host presets using their shared effective settings while preserving omitted Advanced fields in immutable Agent versions.
- Page native history and large results, archive settled review payloads and rotate acknowledgment retries fairly.

### Fixed

- Deliver an Agent's instructions to Claude in workflows and Agent chat.
- Run the unit suite in CI with its own disposable PostgreSQL inside the offline verification image.
- Forget retired Agent worktrees so their branches can be checked out again.
- Run Claude workflow turns whose MCP check, execution correlation and terminal result now match the rest of the workflow engine.
- Replace a source transfer that expired on the Worker and wait for the Worker to reconnect, instead of retrying the expired transfer until the Job times out.
- Read per-Job quota source trees from their quota folder when preparing the private repository on a Worker.
- Report a missing project folder on Main or a laptop as `ROOT_DIRECTORY_MISSING` instead of an internal error.
- Wait 30 seconds before re-inspecting a Job runtime the Worker rejected, and retry immediately when only the Worker connection was pending.
- Reclaim expired Worker transfers before counting staging capacity for a new Job.
- Keep collecting Worker telemetry after one busy sample times out.
- Keep each computer's native qualification independent when multiple hosts check the same installed binary.
- Deliver approvals on the initial native connection and retain response history after the provider process closes.
- Finish source cleanup after the original native finalizer and use cleanup read authority without renewing model-tool access.
- Preserve original execution, process and journal ownership through reconnects, Main restart, worker crashes and credential renewal.
- Continue verified original sessions after a host preset changes while retaining latest enabled settings for new launches.
- Keep retained remote Orchestrator source claims active until the original process closes, preserving ownership and storage accounting during review turns.
- Retain the original scoped Worker credential atomically when an Orchestrator finishes its initial turn, preserving authenticated review access through credential cleanup.
- Start and recover fully placed Agent workflows using their accepted host directories while preserving the workspace selection and authorization checks.
- Keep scoped cancellation available on saturated channels and retry original approval responses only when non-delivery is proven.
- Keep Main available when a native catalog cannot select an automatic default model, persist its unavailable state and expose it through Settings and Operator MCP.
- Let an operator select one native preset while other harnesses remain unavailable, retaining native checks, revisions and idempotent retries.
- Forward explicit native acceptance file selections through the queued root command.
- Reduce native publication database reads by reusing validated records for one frame and combining fresh source, entry, receipt and lifetime queries; retain all ownership and commit checks.

### Security

- Retain sandbox permissions, scoped credentials, assignment checks and owner fences across local and remote artifact and review paths.
- Preserve kernel-backed native closure evidence and revalidate authenticated reconnects without authorizing replacement launches.

## [0.0.50] - 2026-10-06

### Added

- Add shared Operator and Agent chat session controls for manual compaction, Plan mode, context usage and supported native context settings, with matching HTTP and Operator MCP operations.
- Add capability-driven chat controls and persistent command receipts, preserving drafts, native session identity and denied-caller behavior.

### Fixed

- Keep native context observations separate from editable settings revisions and retain newer Worker receipts when replies arrive out of order.
- Give configuration inspection separate process ownership, preserve saved OpenCode connection facts and observed version, and retain the caller on authorized Agent control reads.
- Page complete MCP tool catalogs within existing Worker relay limits while retaining schemas, annotations, grant filtering and cursor validation.

### Validation

- Retain prior focused passing checks, including 85 conversation integrations, 123 Codex adapter cases, Worker ownership and callback checks, MCP catalog/permission checks, and actual namespace routing.
- Codex Operator on Main and device, Codex Agent on Main, and OpenCode Agent on Main passed their ordinary native control journeys on earlier candidates.
- Integrated main v0.0.49 once and passed direct typecheck and lint. Release was completed under the owner order without further native tests or a complete acceptance rerun.


### Verification

- not verified: paired Worker restart case (moved to crosscomputer lane)
- not verified / follow-up: Codex Agent/device first-turn callback timeout; remaining OpenCode Operator and device control journeys; Claude Full-access context-setting live coverage. Main’s explicit Full-access Claude policy is preserved.
- not verified / follow-up: browser acceptance and interrupted compaction dispatch recovery. The full session-control acceptance matrix is incomplete; no complete native or browser acceptance is claimed.
- not verified / follow-up: final caller-context and saved OpenCode inspection adjustments received typecheck/lint only under the owner release order; native reruns were stopped.
## [0.0.49] - 2026-10-06

### Changed

- Require explicit Full access for Claude profiles, presets and Agents at Save and Start through the UI and Operator MCP. Existing unsupported values remain readable until explicitly corrected; they are never upgraded silently.
- Retire Claude read-only and workspace-write execution policy and the custom AppArmor prerequisite. Application grants, permission rules and native qualification still apply to Full access.

### Fixed

- Retain the saved Claude host profile for local workflow execution and the complete accepted request during native inspection, including its execution context and correlation. Compare JSON values independently of object key order.
- Deliver the scoped application bearer credential to the inspected Claude HTTP connection before requiring connected health, while retaining endpoint validation and the SDK credential acknowledgement.
- Deliver pinned Agent instructions and verified skills through the Claude SDK instruction channel.
- Persist Claude native correlations through an upgrade migration and validate workflow completion against the original SDK result and native message receipt.
- Preserve sanitized native failure diagnostics before cleanup and keep detached desktop browser files outside temporary build directories.

### Verified

- Passed typecheck, lint, build and the affected contract, API, UI, authenticated MCP and PostgreSQL regressions, including denied callers, persisted Full access readback, invalid-mode Start refusal and database upgrade behavior.
- Installed and qualified Claude Haiku (`claude-haiku-4-5-20251001`) with Full access on the local PC; completed a saved-profile workflow with a real native session and accepted result.
- Confirmed Claude, Codex and OpenCode saved presets are eligible, installed services are active, the production database is separate, and the dashboard and desktop icons resolve.
- The approval-case timeout passed its single unchanged rerun. The installed service also recovered an initial database response deadline on its unchanged automatic startup retry; final installed verification passed.

## [0.0.48] - 2026-10-06

### Fixed

- Route managed MCP requests from native PID namespaces through the authenticated owning endpoint, preserving scope checks and revocation.
- Preserve the original active OpenCode turn generation during recovery, and recapture the same running output call when an approval observer releases its writer lease.
- Open the scoped Run graph publication before adopting artifacts with retained native approval receipts, preserving original approvals and publication results across restart.
- Register native fixture databases and recover only idle owned databases after process closure, retaining active or foreign resources for confirmed cleanup.
- Share private credential copying between the native runner and Haiku qualification fixture, preserving refreshed test credentials and the original host login.
- Apply the artifact restart fixture's exact four-approval and zero-join expectations to its single-entry scenario.

### Verified

- Completed all 20 previously untested single-computer OpenCode cases locally: artifacts, mixed-provider handoffs, review returns, joins, approvals, handoff limits, audited qualification, Agent chat fork and terminal human-access isolation.
- Qualified Claude Haiku (`claude-haiku-4-5-20251001`) through real native lifecycle and tool-policy checks. In-app Codex subjects used `gpt-5.6-luna` at medium reasoning; OpenCode used the pinned 1.18.31 binary.
- Passed focused unit, authenticated MCP and PostgreSQL regressions, plus typecheck, lint and build. Two timing-only failures passed their single unchanged-case reruns under the owner rule; assertions and deadlines remain unchanged.

## [0.0.47] - 2026-10-06

### Fixed

- Measure the selected executable's real hash in qualification deadline regression fixtures, so current integrity checks admit the valid candidate and reject a replacement before any native suite runs.

## [0.0.46] - 2026-10-06

### Added

- Discover owned Operator conversations and retry creation with a command ID without creating duplicates.
- Page Operator message history and activities through MCP, and inspect the configuration pinned to an existing conversation or request.
- Use separately scoped file and management capabilities together in Codex and OpenCode Operator turns, including attached-spec workflow creation and persisted readback.

### Changed

- Return authorized execution-location details from workspace updates and command replays.
- Recover owned OpenCode Operator sessions through observation attachment without issuing new management credentials or starting another turn.

### Fixed

- Recheck workspace mutation and replay authority under the command transaction, and require read access for Operator sends that return conversation state.
- Compensate failed workspace provisioning after receipt, audit or commit failures, retaining uncertain commits for recovery.
- Report malformed, unsupported and oversized MCP requests as safe client errors.
- Preserve file declarations, original native session history and both credential lifecycles when a text-first Operator resumes with an attachment.
- Retain split native fixture notifications through complete JSONL records and avoid saved-thread reads for stateless events, preserving burst delivery, bounded history and cursor coverage.
- Join already active Job preparations when draining queue work, so closure failures and recovery remain observable after an automatic rescan.
- Preserve process-closure refusal causes in source recovery diagnostics and archive requested native acceptance evidence before disposable storage is removed.
- Reconcile completed current-turn tool activity through its original native owner so saved Codex results can settle without conflicting with late-child activity guards.

### Security

- Audit direct calls to known tools hidden by grants, while preserving unknown-tool responses and failing closed when audit storage is unavailable.
- Keep file credentials separate from owner-delegated management grants; retain read-only harness policies, live revocation checks and scoped recovery ownership.




## [0.0.45] - 2026-10-06

### Added

- Read and retry dynamic harness compatibility checks through Operator MCP with the same contracts, grants and audit service as the local app.

### Changed

- Accept compatible Codex, Claude Code and OpenCode installations by checking their observed runtime contracts rather than exact release versions or recorded schema hashes.
- Prefer the computer's installed native Codex, with the bundled package as a fallback, and read model catalogs and supported settings from the selected harness.
- Recheck compatibility when launcher or native payload identity changes, while preserving recorded Run, WorkflowVersion and native-session provenance.

### Fixed

- Make newer compatible Codex installations usable with their own model catalogs, including Codex 0.160.0/0.160.1 and gpt-6-luna at medium effort.
- Resume saved native sessions across compatible harness releases without rewriting their historical version facts.
- Report the observed harness version and missing protocol contract when compatibility verification fails.
- Keep dedicated Codex and Claude native verification storage disposable, including cleanup after failed scenarios.
- Include the MCP client required by the Claude runtime in deployed production dependencies, so the compiled API can start.

### Security

- Preserve launcher integrity and path trust, credential isolation, read-only enforcement, sandbox settings, approval policy and authenticated host-bound qualification.
- Keep MCP and Worker credentials scoped and separate from the implicit local human; compatible-version checks grant no execution or write authority.

## [0.0.44] - 2026-10-06 - 2026-10-06

### Fixed

- Observe each provider's native startup event during installed recovery verification, requiring the bound execution and session and rejecting replayed history.
- Remove the installed test's runtime workspace after native cleanup on success and failure, while retaining production data and persisted audit history.
- Retire the obsolete installer-owned browser-access setting during production updates, preserving native provider configuration and MCP security.
- Give the standalone migration command a separate bounded DDL deadline while retaining API request deadlines, transactions and migration locks.
- Remove unsuccessful release staging without deleting an activated release or production data.
- Snapshot deployed API and workspace dependencies into independent files so later source builds cannot mutate an installed release.
- Read committed Run-only snapshots during native publication without taking a mutation-blocking Run lock; preserve live grants, immutable pins, locked execution detail and mutation/Stop checks.
- Cover delayed read/write responses, persisted write readback, replacement connections after SQL cancellation and bounded missing replies in the PostgreSQL deadline regression.
- Preserve the supported OpenCode credential key when disposable test storage changes launcher identity, with unit and live native preflight coverage for legacy configuration merging.
- Bind isolated OpenCode preflight and execution to the fixture-owned configuration file and directory, preventing a later source-directory override, restoring both settings during cleanup and preserving managed-launcher and credential checks.
- Use one private OpenCode user-profile entry for native execution and managed MCP setup, retaining source ownership checks and restoring the prior configuration home.
- Include the MCP client in production API dependencies so the compiled Claude runtime and installed API start without development packages.
- Retain server-side failure codes and locations for unexpected Operator MCP errors without logging private error text, tool arguments or credentials.
- Keep the native version-command deadline separate from installation verification and confirmed process cleanup during qualification, preserving binary guards and cancellation.

### Changed

- Verify compiled production hosting and scoped agent HTTP/MCP readback with denied callers after the noauth upgrade; verify credential-free human creation/edits in the actual browser without altering OS client attribution.
- Retain redacted private Operator failure events and attempt independent test resource cleanup when another cleanup step fails.
- Retain bounded database wait and blocker diagnostics during installed recovery verification.
- Document OpenCode runtime isolation, private native storage and the Node/Bubblewrap requirements after the installed file-runtime upgrade.

## [0.0.43] - 2026-10-06

### Added

- Explicit native harness approval handling for workflows, configured through the Board and Operator MCP with compatible pinned Agent settings and saved permission rules.
- Publish declared artifact outputs from local Codex/OpenCode and connected Codex workflow turns through authenticated MCP and retain their original publication records for recovery.
- Restore checkpoint-bound OpenCode approval sessions after verified restart without creating replacement native turns.

### Changed

- Retain every terminal handoff activation in Run output, including results from repeated review revisions.
- Preserve frozen activation inputs during upgrades and provide the original caller through trusted execution context.
- Sixteen real-native workflow cases covering OpenCode artifacts, mixed Codex/OpenCode handoffs, review returns, joins, approvals and handoff limits were verified locally in v0.0.48. All three Codex-only cases passed in the original gate.
- The OpenCode approval-wait lifecycle case was verified locally in v0.0.48.

### Fixed

- Give workflow native-output storage a distinct migration number after the published Operator terminal migrations, preserving both capabilities when upgrading an existing database.
- Preserve fresh original OpenCode terminal history after requester attachment, separating the current history observation from the original prompt submission generation.
- Restore the original requester from its saved approval checkpoint before recording a response, joining startup recovery and retaining native identity and delivery checks.
- Retain original Codex command output deltas when its completed command omits aggregated output, keeping native command, sandbox witness and process closure validation.
- Close fixture-owned native processes and remove isolated databases and private directories after successful or failed acceptance runs, retaining cleanup and verification failures.
- Accept the original first Codex transport generation for local and installed artifact storage, and recover its budget records without changing native identity.
- Preserve original approval checkpoints when restart begins before the active graph invocation releases its Run owner.
- Drain graph finalization writes along with activation tasks before Stop or restart releases ownership.
- Keep resumed native observation on one writer lease until another approval or terminal result, so original MCP artifact calls remain authorized.
- Cancel pending artifact adoption before restart locks the Run, then recover the same published output after recomposition.
- Pass pinned file references through strict download validation during artifact adoption while retaining hash, size, scope and byte verification.
- Adopt local workflow outputs after native settlement and resume unfinished adoption from the saved terminal execution after restart.
- Use the same pinned artifact declarations during preflight and execution, and lock Run parents before artifact execution rows to prevent publication deadlocks.
- Preserve original OpenCode call and permission names under both supported MCP connection names.
- Validate Codex sandbox probe command payloads within the selected shell wrapper while retaining original session, terminal and filesystem checks.
- Bind Orchestrator approvals to the accepted requester ancestry across delegated work, review returns and handoff-limit continuations.
- Settle permanent failures and enforce one execution budget across retries, queued activations, returns and denial continuations.
- Resolve choice branches and exhausted connections in separate causal join rounds, with replay-safe dispatch when branches arrive concurrently.
- Support combined handoff/artifact results, clean choice-node finishes and durable direction waits for accepted review findings or exhausted routes.
- Check derived return and notice sizes against persisted PostgreSQL envelopes before acceptance, including large numeric payloads.
- Preserve safely unsubmitted or settled handoff work across restart, and physically close invalid artifact turns while retaining validation failures.
- Reconstruct activation-result publication records for authenticated canonical graph reads after review cycles.
- Lock the Run before its execution when checking original native output approvals, preventing deadlocks with credential recovery.

### Security

- Run sandbox qualification from an immutable program in protected storage, retaining the original actor and descendant write-denial checks and verified cleanup.
- Keep native output storage outside agent write access, verify original native call ownership and sandbox policy, and enforce saved OpenCode permissions and original approvals for output operations.
- Retain grants, scope checks, native closure records and credential revocation through output publication and approval recovery.

## [0.0.42] - 2026-10-06

### Added

- Dedicated test PostgreSQL, owned disposable databases, and private homes, storage, MCP routes and runtime directories for each test invocation.
- Ownership and cleanup recovery checks for database-backed tests and native acceptance.

### Changed

- Root and API test commands, including selected-file runs, provision isolated resources and preserve current Foreman Code local-human and scoped MCP behavior.
- Installed production verification uses the separate `production:verify` command and refuses disposable test contexts.

### Fixed

- Keep source capture and qualification fixtures inside owned storage, join pending work on teardown, and keep controller Node startup options out of native commands.
- Local smoke shutdown drains pending web requests before closing its dev server; settled resources are removed after failed assertions too.
- Native acceptance uses explicit private provider profiles and managed MCP configuration, with retained diagnostics when physical cleanup cannot be confirmed.
- Bounded MCP readback fills its response budget while preserving JSON characters, identity, choices and continuation integrity.

### Security

- Tests reject application and production database connections, ambient database fallbacks, and cleanup outside owned database or filesystem roots.
- Native agents receive scoped provider and MCP settings without inheriting test-controller credentials, database selectors or the ambient user home.
- Codex model diagnostics strip App and controller credentials and disable only configured App MCP entries, preserving provider sign-in and native startup with empty MCP configuration.

## [0.0.41] - 2026-10-06

### Added

- Add an opt-in live Haiku check for the installed Claude SDK, covering native lifecycle, resume, fork, history and full-access tool policy.
- Show when live or saved chat messages have been shortened, including matching HTTP, SSE and Operator MCP readback.

### Changed

- Qualify the installed Haiku profile for full-access lifecycle and tool policy. Active cancellation, startup prompts, read-only sandbox and workspace-write sandbox remain unqualified in this profile.
- Apply backpressure to Claude event streams while retaining a bounded UTF-8 text prefix and terminal events.
- Retire completed callback and file-call resources while keeping persisted retry records available.

### Fixed

- Resume ended or failed Claude sessions automatically with their saved native session ID, retaining failure records and avoiding duplicate input.
- Keep response ownership through tool rounds and compaction, and handle terminal results that contain no assistant reply.
- Recover approvals, cancellation and chat closure after interrupted storage writes without replaying prompts or repeating acknowledged native effects.
- Save terminal history before settling chat turns while keeping accepted message inputs unchanged across database upgrades.
- Retry interrupted Operator cleanup without reading stopped native managers, preserving known unsent inputs and their saved failures.
- Wait for fixture native turn state before injecting startup-persistence recovery events.
- Support Claude management and file tools through the official SDK with configured Foreman Code MCP connections, supported installation aliases and decoded Markdown readback.
- Roll over full session bookkeeping safely and preserve active-turn and observer ownership checks.

### Security

- Enforce saved tool policies, delegated grants, callback ownership and replay protection for native tool calls and authenticated MCP operations.
- Reject database credentials before Claude runtime allocation and preserve scoped credential identity across supported installation aliases.

## [0.0.40] - 2026-10-06

### Fixed

- Stabilize the Job queue HTTP/MCP parity regression by joining replay-triggered queue scans before reading cancellation revisions. Preserve denied access, revision conflicts, persisted readback and idempotent cancellation across both transports.

## [0.0.39] - 2026-10-06

### Fixed

- Preserve the original managed-launcher location when native acceptance inspects copied MCP configuration, then install and use the fixture-owned launcher. Keep scoped credential provenance and preflight enforcement intact across both supported environment names.
- Restore the outer isolated launcher setting during cleanup and prevent legacy environment aliases from redirecting native route writes outside owned storage.

## [0.0.38] - 2026-10-06

### Fixed

- Restore interrupted heavy-job slot records from their acquired queue tickets, preserving capacity for unresolved native work while allowing later jobs to use free slots.
- Keep existing process and token ownership checks intact. Cover a lost coordinator with a live child process and mixed scheduler versions, with owned process and filesystem cleanup.

## [0.0.37] - 2026-10-06

### Added

- Support native questions, form input and standalone elicitation through shared web, HTTP and authenticated MCP responses, including remote execution.
- Control and recover owned Codex child sessions, including prompts, interruption and their own native approval or input callbacks.

### Changed

- Preserve implicit local human access and the existing scoped MCP and worker credentials after browser authentication removal.
- Qualify native acceptance per provider, allowing Codex cases to run independently of an unused OpenCode installation.
- Correlate late session and turn acknowledgements with the original accepted request and retain startup output until admission is persisted.
- Run selected native acceptance files with invocation-owned databases and preserve process-group cleanup and qualification diagnostics.
- OpenCode approval isolation (E03-A01), OpenCode Agent chat fork and terminal OpenCode local-human isolation were verified locally in v0.0.48.

### Fixed

- Report native model-catalog refresh failures separately from an unadvertised model, and close owned metadata inspections before session admission.
- Preserve a confirmed prompt rejection that arrives during a native history read, keeping recovery usable for an explicit retry.
- Recover known unsent chat requests and failed cleanup across service restarts while keeping uncertain native submissions from being replayed.
- Preserve complete assistant output, callback ordering and child controls when native startup or persistence acknowledgements arrive late.
- Reconcile input responses after a lost database commit without sending another native response, and preserve Operator readback and file delivery through cleanup.
- Observe the selected Run canvas from the canonical cache without replacing its fetcher or clearing a retained Stop before both cleanup readbacks settle.

### Security

- Reject supplied application-global credentials before native qualification or idle diagnostics, while preserving scoped App MCP tokens.
- Keep owner, session, generation, native request and authorization checks intact across callbacks, child controls, diagnostics and recovery.
- Exclude both supported App MCP credential names and configured bearer credentials from idle diagnostic processes.

## [0.0.36] - 2026-10-06

### Fixed

- Copy Codex plugin caches into disposable native acceptance storage without following stale internal version aliases. Preserve linked caches and available plugin assets while isolating writes from the original profile.
- Verify internal and external plugin links stay isolated and temporary storage is removed on success and failure.

## [0.0.35] - 2026-10-06

### Fixed

- Reclaim a heavy-job slot after its coordinator exits or its PID is reused and the published process group is empty, even when unrelated process environments cannot be read.
- Retain slots with live detached token-bearing workers and preserve conservative handling of foreign, malformed, unreadable or incomplete ownership records.

## [0.0.34] - 2026-10-06

### Fixed

- Pass the owned fixture directory explicitly to terminal OpenCode requests, preventing inherited PWD from creating the native session in the surrounding checkout.
- Verify native MCP startup reads the fixture's unique placement marker while preserving every local HTTP denial, scoped MCP permission and cleanup assertion.
- Check the selected native OpenCode model and provider through the shared qualification service before terminal launch, keeping unsupported models separate from missing provider credentials and closing the diagnostic process before the unregistered isolation client starts.
- Terminal OpenCode local-human isolation was verified locally in v0.0.48. Native preflight reports missing provider credentials explicitly. Both Codex isolation cases passed on Mana in the original gate.

## [0.0.33] - 2026-10-06

### Fixed

- Read installed OpenCode MCP credential provenance before switching native acceptance to its owned launcher, preserving the verified token reference across merged native configuration. Keep managed-launcher and scoped credential enforcement intact; remove copied login state during cleanup.

## [0.0.32] - 2026-10-06

### Added

- Isolated OpenCode file delivery for Agent and Operator chat, including attachments and inherited references.
- Follow-up input for idle native OpenCode subagents through authenticated Operator MCP, with scoped denial, idempotent commands and persisted readback.

### Changed

- Discover file tools before model input and bind file-operation credentials after native acknowledgement.
- Support the full accepted image attachment count and size with bounded native media identities and recovery history.
- Keep native acceptance histories, caches, configuration changes and MCP routes in disposable storage, and retain redacted failure codes in run logs.
- OpenCode approval isolation (E03-A01), audited OpenCode qualification and OpenCode Agent chat fork were verified locally in v0.0.48. Codex lifecycle and fork cases passed in the original gate; this group adds no Claude provider case.

### Fixed

- Preserve child agent, model, variant and system settings on follow-up input, including explicit unnamed variants during fork and reconnect.
- Synchronize native and file-tool working-copy edits, retain edited versions across crashes and publish their current bytes.
- Complete queued chat turns despite retryable cleanup failures, and recover owned cleanup after API or native-process restart.
- Give Operator file turns conversation-owned storage while retaining scoped management access and distinct file credentials.
- Recover accepted inline media after conversation restart and fork, preserving ownership and avoiding duplicate delivery.
- Preserve native child chronology, capability revisions and chat event subscriptions as queued turns advance.
- Forward selected acceptance files through the root runner and configure the actual fixture MCP endpoint before native submission.

### Security

- Verify namespace, process generation and vault ownership before native file access, isolating API vaults and other conversations' files and media on the pinned Node runtime.
- Separate pre-acknowledgement discovery from authenticated file operations, validate publication provenance and recheck scope, revocation and writer lifetime before commit.

## [0.0.31] - 2026-10-06

### Fixed

- Initialize the disposable database in the Operator Claude publication recovery fixture before its unchanged five-second behavior deadline. Keep authenticated file publication, replay, revocation and persisted readback checks, and close fixture resources after the test.

## [0.0.30] - 2026-10-06

### Fixed

- Give native workflow acceptance invocation-owned CLI configuration and a temporary managed launcher, routing scoped credentials to the fixture API instead of an ambient installation's fixed endpoint.
- Preserve installed MCP names and credential references, reject unmanaged connections through native preflight, and remove invocation-owned launcher resources during fixture cleanup.
- Keep the selected Codex login in the private fixture CLI home, with private file permissions and cleanup after native processes close; leave the original native configuration untouched.
- E03-A01 approval isolation was verified locally with the connected OpenCode Go provider in v0.0.48.

## [0.0.29] - 2026-10-06

### Fixed

- Load the shipped Worker mount before its installed Codex qualification test creates temporary identity state, keeping cold module compilation outside the unchanged five-second behavior deadline and preventing timeout leftovers. Preserve Main proof, installation identity, revision and fail-closed checks.

## [0.0.28] - 2026-10-06

### Fixed

- Recover finalized Claude file publications in Operator message attachments after credentials are revoked or publication adoption is interrupted.
- Verify authenticated MCP publication and replay, then persisted message readback after credential revocation; cover unauthorized requests and conversation isolation.

## [0.0.27] - 2026-10-06

### Fixed

- Give PostgreSQL responses a bounded delivery grace after the server's unchanged SQL deadline, avoiding false client timeouts while a completed write acknowledges durable WAL. Preserve synchronous commit, query cancellation, transaction locks and execution ownership.
- Report Run inspection read deadlines, cancellation, lock timeouts and deadlocks consistently through HTTP and Operator MCP, with safe reasons and SQLSTATE instead of private database text.
- Verify completed queries with delayed responses, server cancellation of slow SQL and bounded failure when the response is withheld, with proxy sockets cleaned on success and failure.

## [0.0.26] - 2026-10-06

### Fixed

- Verify local API access guidance after rejected harness compatibility retries, preserving the existing report for both unavailable and denied access without requiring browser account authentication.

## [0.0.25] - 2026-10-06

### Fixed

- Verify Codex MCP absence through the requested named CLI lookup instead of an obsolete empty catalog fixture.
- Cover definite missing names, failed lookups, contradictory output and malformed named configuration through the public inspection API and real subprocess runner.

### Security

- Preserve failure classification: unreadable or malformed MCP configuration cannot be mistaken for a definitely absent entry.

## [0.0.24] - 2026-10-06

### Fixed

- Make Agent chat creation and native inspection fixtures return only the requested configured MCP entry, covering both Foreman Code and supported legacy installation names without fabricating a naming collision.

## [0.0.23] - 2026-10-06

### Added

- Selected unit and native acceptance files through the root heavy-job queue and owned disposable test databases.

### Changed

- Open local development and production dashboards without account setup, login, passkeys, browser tokens or cookies.
- Preserve the former browser owner's conversations, attachments, permissions and command retries across upgrade and restart.
- Native human-access isolation and credentialed OpenCode qualification were verified locally in v0.0.48; Claude Haiku lifecycle and tool-policy qualification also passed.

### Removed

- Browser authentication endpoints, sign-in/setup pages, account/session tables and authentication dependencies.

### Fixed

- Serve local HTTP before optional native model discovery, while retaining qualification checks and joining discovery during shutdown.

- Read dashboard root location and root policies through local HTTP without login.
- Reconcile a lost Start response after upgrade using the original Run and command ownership.
- Preserve schedule ownership, occurrence history and exhausted cursors through no-login HTTP and authenticated MCP.
- Allow scoped callers to read their own permissions while retaining operation-specific checks.
- Give cold native conversation attachment its startup budget before observing the existing turn.
- Preserve compiled production hosting, queued Job access, native streaming and Auto placement after authentication removal.

### Security

- Keep local services on loopback with origin checks and OS socket/process attribution for human requests, including the development proxy.
- Preserve authenticated MCP grants, scopes, revocation, read-only access, human approval boundaries and harness isolation.
- Preserve Foreman Code package and environment names and recognize both supported MCP credential spellings when isolating native clients.

## [0.0.22] - 2026-10-05

### Fixed

- Return only the configured MCP entry in shared native replay fixtures, keeping canonical and legacy naming collision checks intact and restoring native output and late child-completion coverage.

## [0.0.21] - 2026-10-05

### Fixed

- Reuse the reviewed native MCP launcher for local production's automatic credential routing, while keeping production data separate.
- Transition managed launchers from the previous production directory without changing native commands, credential references, tool policies, approvals or disabled flags.
- Preserve launcher registrations across older and concurrent writers, and recover interrupted or lost transitions from the retained managed installation.
- Keep unused routing folders intact without recognizing an uninstalled or unmanaged launcher.

### Changed

- Scope OpenCode live qualification to its approval case so Codex-only cases can run independently, retaining each provider's qualification and original assertions and deadlines.
- Use explicit verification subject models without changing user defaults: interim Codex gpt-5.6-luna with medium reasoning and Claude Haiku when selected.
- Single-computer OpenCode lifecycle, qualification, fork and isolation cases were verified locally in v0.0.48, along with Claude Haiku qualification. Desktop production installation and native recovery verification are recorded separately.

## [0.0.20] - 2026-10-05

### Fixed

- Reduce live workflow Start and reconciliation overhead by observing committed native progress, reusing validated unchanged history and projections, and reusing prepared reads on each dedicated PostgreSQL owner session.
- Inspect named Codex MCP configuration without waiting on unrelated server status checks, while retaining configuration, credential, alias and ownership validation.
- Retain content-free workflow, database and native timing diagnostics for investigating execution delays.

## [0.0.19] - 2026-10-05

### Fixed

- Keep ready native output in bounded batches after scheduler pauses, avoiding fragmented database publications while preserving prompt silent-stream flushing and immediate approval and reliability events.
- Add a deterministic scheduler-pause regression without increasing native stream test timeouts or relaxing frame-order, source-capture, lease, or Operator MCP checks.

## [0.0.18] - 2026-10-05

### Fixed

- Keep real native workflow acceptance storage under a validated private location, independent of shared job temporary directories.
- Use supported Codex test models and medium reasoning with explicit overrides, without changing product defaults.
- Give workflow agents return-routing templates from accepted request IDs to reduce copying errors while retaining exact backend validation.

## [0.0.17] - 2026-10-05

### Fixed

- Publish native approval interrupt bindings as soon as their checkpoint is saved, so independent sibling executions can progress while approval prompts remain usable in the app and Operator MCP readback.
- Commit delivered approval responses through the active Run owner and queue continuation behind the existing graph invocation, avoiding duplicate native submissions.
- Join queued approval continuation during Stop before reclaiming cleanup ownership, including responses delivered while a sibling is still active.

## [0.0.16] - 2026-10-05

### Fixed

- Restore native chat and launcher test fixtures to the Foreman Code MCP naming, supported aliases and MCP list/get contracts without weakening credential or delivery checks.
- Keep transfer security fixtures independent of checkout depth, align installed Codex qualification with the shipped suite, and validate current workflow saves through behavior rather than obsolete migration text.
- Complete selected Board Activities and Operator file HTTP fixtures, retain exact Claude preset readback, and scope Stop reconciliation verification to the selected Run.
- Keep attachment picker-order assertions independent of concurrent HTTP arrival order and complete workspace root metadata fixtures for route verification.

### Security

- Pin both Foreman Code and legacy GraphQL App MCP credential names during Codex diagnostics, preserving credential exclusion for existing native configurations.

## [0.0.15] - 2026-10-05

### Fixed

- Align Operator OpenCode file-delivery fixtures with the canonical Foreman Code MCP entry, preserving exactly-once attachment delivery and file-only authority for Markdown, images and publication flows.
- Report persisted Operator turn errors directly in delivery tests and verify MCP isolation for supported and legacy connection names.

## [0.0.14] - 2026-10-05

### Fixed

- Keep ready native output in bounded publications when database lease checks are slow, so parallel stream drains preserve progress, output order and writer ownership.

## [0.0.13] - 2026-10-05

### Added

- Show the latest scheduled attempt, safe outcome guidance and an accepted Run link in the schedule dialog.

### Changed

- Dispatch independent schedules with bounded concurrency and recover missed occurrences in immediate batches.
- Bound Start preparation, reuse validated preflight across short-interval retries and refresh open schedule readback without replacing edits.
- Isolate installed package files across worktrees so parallel installs cannot change native executable identity metadata during qualification.

### Fixed

- Preserve pending and exhausted occurrence cursors when unchanged enabled settings are saved or enabled again, including elapsed Once saves in the UI and Operator MCP.
- Default Once to the next device-local calendar date across daylight-saving changes.
- Record stale roots, harness instances, removed installations, unavailable sources and revoked devices as immediate scheduling rejections while retrying temporary inventory gaps.
- Restore saved harness selections after restart and check their persisted revisions before accepting a scheduled Run.
- Keep the installed Node runtime stable during native acceptance isolation and qualify scheduled placement using its persisted model defaults.
- Return decoded Markdown alongside pinned bytes in Codex file callbacks and live qualification, with fresh qualification suite evidence.

### Security

- Retain cancellation and authorization fences through Start preparation and placement checks; log safe application and device classifications with workflow context without exposing native output or credentials.

## [0.0.12] - 2026-10-05

### Fixed

- Restore companion pairing and status requests after the Foreman Code rebrand by retaining the valid `X-Graphql-Companion-Session` header used by installed companions and servers.

## [0.0.11] - 2026-10-05

### Fixed

- Restore the source workspace's full frozen dependency installation after production staging, including failed deployment, so later commands run unattended without switching to production-only dependencies.
- Preserve both deployment and workspace-restoration errors when staging fails.

## [0.0.10] - 2026-10-05

### Added

- Retain redacted OpenCode qualification transcripts and MCP request and file-response details for diagnosing native failures.
- Select explicit native acceptance test files through the root runner while preserving isolated test databases and the default lifecycle gate.

### Changed

- Run each OpenCode live qualification check once and require qualification suite revision 5, so another model attempt cannot hide a failed check.

### Fixed

- Include decoded UTF-8 Markdown in authenticated file MCP reads alongside the unchanged pinned byte result, preventing marker corruption during model-side base64 decoding.

## [0.0.9] - 2026-10-05

### Added

- Canonical FOREMAN_CODE environment settings with supported legacy GRAPHQL aliases, preserved process/file precedence, and explicit conflict diagnostics.
- Fresh foreman-code MCP entries with recognition of existing graphql connections and human-reviewed configuration migration.
- Rename compatibility and rollback documentation for existing installations.

### Changed

- Product, dashboard, desktop and companion branding to Foreman Code, and first-party private packages and build consumers to @foreman-code.
- MCP discovery, setup and generated agent instructions to Foreman Code MCP while retaining public operations, grants and serialized contracts.
- Local production installation settings and packaged runtime consumers to the canonical names while retaining service, storage, database and pairing identities.

### Fixed

- Preserve old startup commands, managed launchers, scoped native credentials and worker artifact packaging after the rename.
- Reject conflicting old/new installation targets and installer-setting overrides without modifying operator-owned configuration.
- Retain native qualification diagnostics through test cleanup while preserving the full qualification gate.

### Security

- Remove production database passwords and ambient application secrets under both prefixes before native execution; retain existing permission and qualification checks.

## [0.0.8] - 2026-10-05

### Added

- Run-wide Activities for selected Runs, including Job-only Runs and failures before an Agent execution exists.
- Refresh and bounded execution discovery when a selected Run's Agent execution becomes available later.

### Changed

- Page complete public Activity rows within 128 KiB over HTTP and Operator MCP, with cursors for all retained history and heavier snapshots available through Run details.
- Keep incremental Activity reads independent of full execution history, back off unchanged feeds, and batch authorized workspace Run summaries.
- Preserve configured native acceptance evidence directories and private qualification error details while the root runner creates and cleans up its disposable database.

### Fixed

- Preserve historical WorkflowVersion and Run records through database upgrades while keeping current execution on semantics 3.
- Order Run pages chronologically, update cached rows from fresh summaries, refresh evicted history pages, and distinguish Runs that never started.
- Preserve admission-time Agent names in Activity history and save node display names without changing executable version pins or stopping Runs.
- Recover retained rename edits and commands across reloads with concurrent-name checks and existing Stop uncertainty preserved.
- Report native null-error success, cancellation and Claude tool activity consistently in public Activities and normalized Run snapshots.
- Serialize older Activity reads with polling and Refresh, retain valid cursors as history advances, and recover transient failures without losing loaded rows.

### Security

- Revalidate live and delegated Run-list grants, including empty pages, and deny unauthorized workspace and workflow scopes while retaining scoped readers and redacted HTTP/MCP parity.
- Authorize edit-intent advancement before reading caller-private commands, preserving persisted rename recovery and original command identities.

## [0.0.7] - 2026-10-05

### Changed

- Document explicit provider credential configuration and native login locations for the installed user service, including provider authentication failures.

### Security

- Exclude the production database password from native harness environments while retaining explicitly configured provider credentials.
- Apply shared credential filtering to Codex launch, credential refresh and resumed sessions, and reject database-secret reinjection.

## [0.0.6] - 2026-10-05

### Added

- Persistent build request queue with original deadlines, idempotent submission, capacity-aware Auto or fixed placement, and scoped cancellation.
- Start placement overrides, reserved-computer and cleanup status, complete active-request discovery, and paginated queue history through Jobs, HTTP, and Operator MCP.

### Changed

- Reserve computer and source capacity before preparation, and continue claiming work for available computers while other requests prepare.
- Require owner-reviewed Main queue configuration with explicit resource envelopes; retain capacity through uncertain execution and pending publication or cleanup.

### Fixed

- Recover queued, preparing, accepted, and unfinished settled Jobs after Main restart without replacing their saved definition or attempt identities.
- Preserve historical command retries and fixed requests' immutable qualified profile versions after edits.
- Close undelivered cancelled or disabled attempts through fenced non-entry and positive source closure, and keep pending cleanup visible until it completes.
- Restore inspected runtime metadata without creating or extending qualification; retain original journal recovery and cancellation when fresh qualification is unavailable or expired.

### Security

- Preserve live workspace and computer grants, saved source and root bindings, revision conflicts, command receipts, and audited HTTP/MCP denials for queue operations and placement overrides.
- Keep runtime qualification mandatory for new launches and restrict recovery and cleanup to the original owned attempt, releasing capacity only after confirmed closure.

## [0.0.5] - 2026-10-05

### Fixed

- Drain native workflow output in bounded publications so parallel turns and approval waits complete without duplicate native submissions.
- Detach failed event observers promptly while preserving the original native sessions for recovery.
- Preserve caller-selected native acceptance database servers, evidence directories and pinned binaries through isolated test bootstrap.

## [0.0.4] - 2026-10-05

### Added

- A local production install/update command that deploys the compiled API and web shell, runs migrations, and enables user services.
- A persistent production PostgreSQL volume, separate database credentials and storage directories, and a loopback dashboard at port 3041.
- Desktop and session-start launchers that open the dashboard in Chrome, with application and web icons.
- Installed-service checks for native execution, Operator MCP grants, cancellation, database recovery and service crash recovery.

### Changed

- Preserve validated operator configuration across updates and serialize installation, migration and release activation.
- Run the root native acceptance command with an owned disposable database and retained test evidence.

### Fixed

- Serve saved dashboard routes from the production build while preserving API and MCP error responses.
- Restart the API after database ownership loss or an initially failed database activation.
- Confirm and persist native cleanup after systemd removes a killed cgroup.
- Preserve quoted and escaped configuration values and verify installation identity before declaring readiness.

### Security

- Enable qualified native execution only for explicitly selected loopback local production installations, retaining grants, scope checks, sandboxing and execution admission.
- Keep production credentials private and production storage separate from disposable test databases.

## [0.0.3] - 2026-10-04

### Fixed

- Restore native cancellation, recovery and reviewer safety verification with persisted session and turn identities, retaining coverage for both bound and unbound recovered lanes.
- Exercise startup recovery and orderly shutdown with the production rsync availability result in the lifecycle fixture.
- Align source-capture timeout verification with the intended five-minute preparation budget and enable the existing worker execution policy in the source reconciliation fixture.
- Make schedule editor and modal verification independent of the machine timezone while preserving saved instants, device-local display and daylight-saving behavior.

## [0.0.2] - 2026-10-04

### Added

- Build participation and priority settings in Settings → Computers, with persisted status and revision checks through HTTP and Operator MCP.
- Auto Job definitions that select an authorized, ready computer, approved workspace root and compatible qualified runtime at Start.

### Changed

- New Jobs default to Auto; fixed targets and historical execution selections retain their saved facts.
- Job admission reserves computer and source storage capacity before transfer and retains the selection across interrupted transfers, uncertain delivery and recovery.
- The root integration runner supports an explicit file selection through the shared heavy-job queue and disposable databases.

### Fixed

- Preserve saved Auto runtime requirements when editing a Job.
- Block new launches after build participation is disabled while retaining running-job cancellation, recovery and artifact readback.

### Security

- Preserve explicit grants, scope checks, approved source and input revisions, qualified isolation, runtime limits and Main's startup execution gate during automatic selection.

## [0.0.1] - 2026-10-04

### Added

- Byte-bounded interaction summaries and cursor-based retrieval of complete large requests.

### Fixed

- Preserve interaction identity, response options and retrieval cursors in OpenCode model output.
- Keep large interaction responses within the remote worker relay and model text limits.
- Cancel pending MCP approval decisions before commit while preserving committed decisions for readback.
- Distinguish authentication, forbidden, oversized request, service, timeout and connection failures with safe retry guidance.
- Resolve interaction summary schema loading and strict lint errors found during integration.

### Security

- Limit cancellation to the originating authenticated caller and reauthorize every retrieved content chunk.
