# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

