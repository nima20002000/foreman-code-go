# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

