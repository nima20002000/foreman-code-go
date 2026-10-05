# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
