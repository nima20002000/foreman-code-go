# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

