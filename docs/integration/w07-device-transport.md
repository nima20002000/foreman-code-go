# W07-B transport integration manifest

This checkpoint supplies a device-only transport core, not a mounted listener or qualified remote execution.

Root-owned integration:

- Export `packages/contracts/src/deviceConnection.ts` as `@graphql/contracts/device-connection` (dist JS/d.ts), independently of the identity export.
- Pin `ws` 8.22.0 in API and worker artifacts, validate engines/advisories/48-hour release age and resolve the lockfile with pinned pnpm. The existing lock has no equivalent websocket server dependency. No Fastify websocket plugin is required by this Node upgrade adapter.
- Create an explicitly approved separate HTTPS listener, with normal TLS certificates. Never mount onto the browser/MCP API listener or widen its origins, hosts or auth.
- Construct `ws.WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })`. Register `deviceUpgradeHandler(endpoint, websocketServer)` as this listener's upgrade handler and `deviceHttpHandler` as its HTTP request handler. Set bounded HTTP/header/TLS handshake timeouts and connection limits in listener composition. Compression extensions are rejected.
- Export A's `device-identity` and `device-identity-node` alongside the connection export. Supply `signMainIdentityProof(request)` to both the endpoint and device HTTP handler, backed by A's persisted application Ed25519 main identity. `/device/challenge` returns signed identity proof for a fresh worker nonce before pairing. Worker configuration must retain the explicitly approved application-key fingerprint; this is separate from TLS keys.
- Supply the canonical persisted main ID and approved public-key fingerprint to `/device/identity`. Inject A's `PostgresDeviceAccessService.pair`, `authenticateDevice` and `revalidateDevice`; connect A's post-commit revocation callback to `endpoint.revoke(deviceId)`.
- Construct `DeviceEndpoint` with synchronous generation-aware presence publication and authoritative reconciliation. Main close calls `endpoint.close()` before closing its separate listener. W08/W09 must replace the empty checkpoint reconciliation ports when actually integrated. No command buffering/replay exists at W07.
- C bundles `workerConnection.ts`, `connectionSupervisor.ts`, `deviceCarrier.ts`, `deviceWire.ts`, and the shared connection contracts with the pinned ws dependency. `createWorkerConnection({pairing,bootId,appVersion})` returns start/stop/status. Worker service lifetime owns this instance; neither a browser nor SSH tunnel owns it. Endpoint URLs must be `wss://.../device/connect`; no certificate bypass or credential in URL.

Before worker synchronization/readiness, the worker verifies the signed welcome against its approved application-key fingerprint and exact nonce, device/installation, key/auth revisions, boot, client/server epochs, generation and protocol/worker version. The main application version is also signed and must match welcome. Main presence becomes ready only after the worker acknowledges verified proof and completed reconciliation on the same epoch. Missing or invalid proof blocks as wrong-main.

Session binding retains main/device/installation/key/auth revisions and process boot separately from the server-issued connection epoch. Replacements, revocation and shutdown cancel old sessions before presence writes. Heartbeat has live auth revalidation; receipt is connectivity only. Protocol is exact v1 independent of app and provider versions. Dispatch and transfer remain false.

Focused transport doubles cannot qualify real WSS, persisted main restart, the worker service surviving SSH/browser closure, or laptop acceptance. Root/human must supply that evidence after approving listener/TLS/artifact/service changes. No listener, service, security or network settings were changed in this lane.
