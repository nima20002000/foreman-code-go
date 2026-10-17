# Browser stream writer

`browserstream.New(Options)` creates the shared bounded SSE writer. It starts no
goroutines, opens no ports and commits no response headers. Register the owning
lane's route with `app.RegisterStream`, complete authorization and snapshot
readback there, then call `Writer.Run(request.Context(), response)` on the HTTP
handler goroutine. Other goroutines may publish complete frames with
`Writer.Write(frame)` while `Run` drains them.

The writer preserves every accepted frame byte for byte. Event names, IDs, JSON
serialization, snapshot fallbacks, subscription ordering, heartbeat intervals and
principal reauthorization remain with their owning domain. A domain can reuse the
existing `: heartbeat\n\n` frame without introducing another envelope or DTO.

The defaults port the frozen `apps/api/src/routes/sseWriter.ts` bounds: 8 MiB per
frame, 256 KiB and 128 frames waiting behind the currently accepted frame, and a
15 second drain deadline. UTF-8 byte length is used. Once a frame is accepted for
writing it is never requeued or sent twice. Overflow, authorization expiry,
request cancellation and write/flush failure discard the remaining queue and
stop the stream. A response writer must expose `SetWriteDeadline`, directly or
through `Unwrap`, so cancellation and queue overflow can unblock a stalled write.
The application's shared error wrapper already preserves that interface.

`Allowed`, when provided, is checked on publication and again before every
response write. It must be concurrency-safe and read the lane's current access
state. `OnStopped` runs once for a failure, outside the writer lock, and should
unsubscribe the lane's event listener. It must not wait for `Run` or `Done`.
`Run` waits for this callback before returning. Explicit `Close` is idempotent,
discards queued frames and does not invoke `OnStopped`. The caller still owns its
normal cleanup and should defer `Close` before entering `Run`.

The HTTP headers match the frozen routes: `text/event-stream`,
`no-cache, no-transform`, `Connection: keep-alive` and `X-Accel-Buffering: no`.
The first queued frame commits and flushes the response; the lane must supply its
initial snapshot before waiting for future events. This also lets an access or
bootstrap failure remain inside the ordinary HTTP error boundary.

## Verification requested from terminal

No test, build, lint or formatting command has run in Web. Execute only the
`backend/internal/browserstream` tests listed in the retained increment's CI
instructions through Foreman CI MCP. The package test includes a public
`app.RegisterStream` HTTP request on a fresh random port and no database.

Frozen TS reference: `8d2ea76c5028ef4458bf8cd64ef8624422e71d9f`.
Merged implementation base: `7fa547058109519a99c904493c916662fde6a474`.
