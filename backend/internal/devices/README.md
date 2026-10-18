# Device carrier lifecycle

`DeviceWire` ports the opaque carrier mechanics from
`apps/api/src/modules/devices/deviceWire.ts` at frozen TypeScript reference
`8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`, source blob
`d90f5eb8562372a90497f57f08d620fec11843cc`. The implementation base is
`6988e479b5f4b0e755ffd623f3f3a8e64d806eef`, tree
`8bc916062afa6503ec4b350d8bb291c2f23a802e`. Existing identity sources and
their tests remain unchanged.

The carrier owns one physical reader, a bounded unread text queue, and one
physical writer. Frame, queue-depth and byte bounds are required inputs from
the future generated contract adapter. Incoming binary messages are malformed;
oversized frames or a full unread queue fail with backpressure, close the
carrier and discard unread frames. Outgoing reservations include both the
active write and queued writes. A rejected or canceled queued send releases
its reservation without replaying or closing the link.

`Next` reads handshake frames with caller-controlled deadlines. `Consume`
takes over already queued and future frames in order, delivering directly to
one synchronous callback. Cancellation of an individual `Next` wait leaves
the stream available; cancellation of `Consume` closes it cleanly. A deadline
on the owned carrier lifetime remains a timeout through physical reads,
writes, queued callbacks and direct callbacks. Cleanup cannot change that
classification based on goroutine scheduling.

`Close` stops admission immediately. `Join` waits for physical reads, writes,
callbacks and the carrier's close operation; it reports the terminal reason
and physical-close failures. Canceling a join wait does not report cleanup as
complete. Callbacks must honor their supplied context. Physical write results
belong to their calling operation and are never retried here.

## Adapter boundary

The available Go import is
`github.com/nima20002000/foreman-code-go/backend/internal/devices`.
Its new carrier API is `NewDeviceWire(context.Context, WireSocket, WireOptions)`
with `Next`, `Consume`, `Send`, `Close` and `Join`. `WireSocket` requires only:

- `Read(context.Context) (text string, binary bool, err error)`;
- `Write(context.Context, string) error`, settling the physical text write;
- `Close() error`, unblocking outstanding reads and writes.

Normal peer closure is `io.EOF`. The optional `TerminalFailure` callback is a
contract-adapter hook: it can retain a validated blocked-frame reason when
the peer closes before queued frames are consumed. The carrier never parses
JSON, creates protocol DTOs, computes canonical hashes, resolves a principal,
or grants authority. `WireError` and `WireLimits` are internal transport state;
the generated adapter maps their codes and limits to the shared contracts.

## Remaining Step 1 dependencies

This is a channel prerequisite, not a completed worker handshake or installed
worker qualification. The checkpoint has no generated Go domain contracts,
shared live management access implementation, or `coder/websocket` dependency.
Their Go import paths and final generated export names have not been delivered
by I. The exact source exports needed by the next device slice are:

| Existing TypeScript import | Required exports or behavior |
| --- | --- |
| `@foreman-code/contracts/device-connection` | `DEVICE_PROTOCOL_VERSION`, `DEVICE_FRAME_BYTES`, `DEVICE_QUEUE_DEPTH`, `DEVICE_BUFFER_BYTES`, `DeviceFrame`, `DeviceFailureCode`, `DeviceSessionBindingSchema`, `DevicePresenceSchema`, `DeviceHello`, `DeviceWelcome` and their generated validators/types. |
| `@foreman-code/contracts/device-identity` | `DevicePrincipal`, `DeviceRegistrationSchema`, `DevicePairingRequestSchema`, pairing grant/result and public identity schemas, `WorkerPairingConfigurationSchema`, main identity/enrollment proof schemas, plus shared `authorizeDevice` behavior. |
| `@foreman-code/contracts/device-application` | Extension descriptor and negotiated-extension types, `parseExtensionDescriptors`, `negotiateDeviceExtensions` and their bounds. |
| `@foreman-code/contracts/device-identity-node` | `pairingProof`, `mainIdentityProofMessage`, `mainEnrollmentProofMessage` and proof verification; the retained identity key signs the supplied exact bytes. |
| `devices/deviceApplicationChannel.deviceNegotiationHash` | SHA-256 over the exact `JSON.stringify` encoding of negotiated extensions. The shared encoding adapter must preserve those bytes; sorting object keys would change this protocol hash. |
| Shared command identity | The shared canonical JSON and `commandInputHash` behavior required by pairing-grant receipts; no local implementation is supplied. |

The frozen device endpoint's minimal authentication port is
`authenticateDevice(token, "connect") -> DevicePrincipal` and
`revalidateDevice(principal, "heartbeat") -> void`, backed by the actual
registration store and shared contract authorization behavior. Its management
service additionally needs I's live-principal lookup and authorization check
through the existing `database.Querier`, plus the shared command coordinator
for pairing-grant idempotency, receipts and audit. These are source-level port
requirements; this slice does not invent replacement Go auth interfaces.

The remaining Step 1 work is generated request/proof adaptation, persisted
pairing and live authorization, the dedicated TLS/WebSocket device listener,
hello/welcome/ready and extension negotiation, generation-bound sessions,
authenticated computer routes/tools, and command registration for the same
`foreman worker` binary. I owns shared composition and dependency resolution.
Step 2 journal/reconnect/revocation/telemetry and real worker operations retain
their issue order. Domain journal meanings stay with E/J/A1. Native config
rewriting to `foreman mcp-launcher` remains the later R/H integration.

## Affected terminal CI request

Twenty new `TestDeviceWire` roots exercise only the public carrier port and
observable operation results. They cover exact byte limits, queue depth and
bytes, cancellation, adapter terminal errors, ordinary close, read/write/close
failures, ordered queued-to-direct handoff, live consumer cancellation,
deterministic deadline classification, and physical settlement. The fixtures
use controlled in-memory carriers; they do not install or pair a real worker,
start a server, connect to a real installation, or claim channel conformance.

Only the terminal controller may run checks through Foreman CI MCP:

- Unit and race checks in `backend/`, package `./internal/devices`, selector
  `^TestDeviceWire`.
- Build, vet and Staticcheck for `./internal/devices`.
- Formatting checks for exactly `backend/internal/devices/wire.go`,
  `backend/internal/devices/wire_test.go` and
  `backend/internal/devices/wire_lifecycle_test.go`.

No check was executed during Web authoring. Existing identity, placement and
worker outcomes are retained evidence and are not requested again. Review
findings resolved while authoring this new port are not preexisting public
bug fixes, and an absent package/function on the base is not behavioral-red
evidence. Full R acceptance remains open.
