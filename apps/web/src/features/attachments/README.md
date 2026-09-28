# FIL-11 — shared chat attachments

Base: `nima20002000/graphql`, `feat/nim-2733-files`,
`4884027a7fa168a4131fb6957a21237c48ceecaa`.

Only new files in this directory are supplied. No composer, backend route,
shared client, contract, stylesheet outside this directory, or dependency file
is changed. The `@graphql/contracts/files` export already exists at this base.
No new dependency is needed.

## Mount lines

Create **one stable client** after agreeing the FIL-03 transport below. Mount
one provider inside the existing QueryClientProvider and authenticated app
boundary, above conversation-keyed panels. Do not put the provider inside a
component keyed by conversationId. Keep the client object stable; replacing it
intentionally starts a new draft lifetime. Remount this provider on an
installation/principal change. The existing session abort boundary also purges
all local selections and fences outstanding work.

```tsx
import {
  AttachmentDraftProvider,
  ChatAttachmentControl,
  useConversationAttachments,
  createAttachmentHttpClient,
} from '../attachments' // From features/conversations; adjust for other parents.

// Integration-owned, agreed same-origin /api/ paths, NOT routes defined by FIL-11.
const attachmentClient = createAttachmentHttpClient(fileUploadPaths)

// Inside the existing QueryClientProvider + authenticated application boundary:
<AttachmentDraftProvider client={attachmentClient}>
  {existingConversationPanels}
</AttachmentDraftProvider>
```

In the parent that owns the conversation send operation:

```tsx
const attachments = useConversationAttachments(fileScope)
// fileScope: TemporaryFileScope | null. Use null until a real conversation exists.

<>
  <ChatAttachmentControl draft={attachments} disabled={isSending} />
  <ConversationComposer
    {...existingComposerProps}
    sendDisabled={existingSendDisabled || attachments.hasBlockingAttachments}
    onSubmit={handleSubmit}
  />
</>
```

Place the control in the parent's reserved composer/action area, not inside
transcript scrolling. Its stylesheet is imported by the component. It has no
portal, floating action, fixed positioning, or nested scroll container. Chips
wrap and filenames truncate, including at a 320px parent width.

The handler integration must use a snapshot, not just the possibly partial
`readyRefs` array:

```tsx
// At the beginning of a NEW send attempt:
const attachmentAttempt = attachments.prepareSend()
if (attachmentAttempt === null) return // A selected file is not ready/has expired.

const request = {
  ...existingRequest, // Keep the existing complete request/intent/target identity.
  attachments: [...attachmentAttempt.attachments],
}
// Retain `request` AND `attachmentAttempt` under the send requestId in the
// existing receipt/attempt owner. Retry that same request unchanged.

// In the EXISTING definite-acceptance/receipt-settlement branch, only:
attachments.acknowledgeSent(attachmentAttempt)
```

This is deliberately not an `await send(...); clear()` recipe: a resolved send
may still report an uncertain or rejected outcome. Upload completion and
`prepareSend()` do not clear anything. A rejected/unknown send keeps the draft.
The acknowledgement is bound to the captured original conversation and exact
selection IDs/pins. It cannot clear newly added files, another conversation,
or files re-selected after removal. Calling it twice is harmless. It does not
send a remote cancel for the files that have just been accepted.

A strict Operator scope is:

```ts
const fileScope = {
  kind: 'temporary',
  chat: { kind: 'operator', ownerPrincipalId, operatorId, conversationId },
} satisfies TemporaryFileScope
```

An Agent scope uses `chat: { kind: 'agent', conversationId, agentId, workspaceId,
workflowId }`. Include `runId` and `executionId` together when applicable. Use
verified conversation context from the host; these IDs are not authorization.
Operator scope never acquires workspace/workflow/run fields.

## Contract/integration gaps — not silently filled in

The frozen files contract provides scopes, immutable metadata, references,
limits and file lifecycle validation. It does **not** specify browser upload,
finalize or cancel request/response envelopes or HTTP routes. The existing
`apiClient.request` always JSON-stringifies bodies, so it cannot send multipart
file bytes without a shared-client change (outside this lane).

`AttachmentClient` is the narrow injection seam. It may be implemented by the
FIL-03 owner using their agreed wire contract. Its `upload` must return a
`FileWithRevision` only after the file is durably ready; its `cancel` targets the
original unsent upload request. Both methods use shared domain types. The hook
validates ready data again even for an injected implementation.

The optional `createAttachmentHttpClient(paths)` supplies a concrete,
MSW-interceptable adapter with **no default/guessed route names**. It is usable
only after FIL-03 agrees this explicit transport convention:

| Operation | Wire convention required by this opt-in adapter |
| --- | --- |
| Upload | POST multipart: `metadata` JSON string containing `{ requestId, scope, filename, mediaType }`, and one `file` part with the canonical MIME and filename. Respond with shared `FileWithRevision`, pending or ready. |
| Finalize | POST JSON `{ requestId, scope, fileId, revisionId }`; respond with shared `FileWithRevision`, ready, with the same exact pins. |
| Cancel unsent allocation | POST JSON `{ requestId, scope }`; respond with 204 and no body. |

JSON operations use the existing shared client. The only new raw transport is
multipart XHR, encapsulated here because shared JSON body handling cannot
carry File/FormData. It mirrors same-origin cookies, Accept headers, the shared
401 notification and session-generation/abort guards. It emits actual browser
progress when available and an indeterminate state otherwise. Upload timeout
is 120 seconds. No file is read into base64 or an application ArrayBuffer.

FIL-03 must verify actual bytes, MIME, size, SHA-256, scope ownership and lineage;
canonical picker hints are not security validation. A retry uses the **same**
upload requestId, including after uncertain upload/finalization outcomes.
FIL-03 must make that idempotent and fence upload/finalize/cancel races. There is
no attempt to invent server readback, request tombstones or authorization here.

Removing a chip aborts its local operation and attempts remote cleanup. Remote
cleanup failure does not resurrect the chip or imply confirmed server deletion;
the failure remains in a TanStack mutation (60-second cache lifetime). Backend
retention/reconciliation must collect any unsent remnants. Provider disposal or
principal change only aborts/purges locally, avoiding cleanup under another
principal's credentials. Integrators needing a cleanup-error notification can
observe the `['chat-attachments', providerId, 'cancel', requestId]` mutations.

The frozen document also delegates both chat send schemas and receipt hash
integration to their owners. Those must accept `MessageAttachmentFields`, use
`messageAttachmentIdentity`, and preserve pin order on replay before mounting
send integration. This ZIP makes no chat schema/hash change.

The existing ConversationComposer has no attachment slot/attachment-only send
API; mount this control beside it in its parent. Attachment-only/empty-text send
behavior must be decided and wired by the composer/send owner, not inferred by
this component. The hook itself supports an attachment-only snapshot.

This lane supplies a human file-picker interaction, not a new backend/MCP
capability. Operator MCP upload/read/send parity and authorization belong to
the FIL backend/tool/send lanes; no MCP parity is claimed for an unmounted
browser control.

## Ownership and lifetimes

Zustand owns in-memory File selections and picker validation only. No File,
object URL or attachment draft is persisted in localStorage. TanStack mutations
own upload response/error/status; progress-only telemetry is in Query cache,
not duplicated in the draft store. Network work is provider-owned, not bound to
the current composer observer. Each operation captures its full scope and
requestId, including an OS picker left open during navigation.

The view owns image object URLs. It revokes them on conversation switch,
removal, send acknowledgement and unmount; returning to a preserved draft
creates fresh URLs. Retries/status updates do not replace the selected File or
leak new URLs. Provider cleanup handles React StrictMode effect replay.

`readyRefs` is convenient readback, not proof that every selected file is ready.
`hasBlockingAttachments` gates the send affordance, and `prepareSend()` performs
an immediate all-or-nothing readiness, expiry and duplicate-pin check. Short
chip text is Uploading / percentage / Checking / Ready / error. Ready is never
called Sent.

## Tests and verification

`attachments.test.tsx` uses the repository's existing MSW server and actual
client boundary. It includes table-driven coverage for every allowed MIME,
JPEG extensions, uppercase/empty browser MIME, multiple files and out-of-order
completion, real/indeterminate progress, pending finalization, upload/finalize
retry identity, network errors, cancellation and late callbacks, failed cleanup,
foreign/malformed responses, limits, both scope kinds, mid-upload/open-picker
navigation, send snapshots, image URL cleanup, StrictMode and session changes.
Fixtures model metadata and browser File bytes; they are not backend document
format-validation tests.

Run in the complete pinned repository:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/web exec vitest run src/features/attachments/attachments.test.tsx --maxWorkers=1
corepack pnpm --filter @graphql/web exec eslint src/features/attachments --max-warnings 0
corepack pnpm --filter @graphql/web typecheck
```

Execution here: the first Corepack attempt could not obtain `pnpm@11.27.0`
(`EAI_AGAIN registry.npmjs.org`). No alternate package versions or npm install
were used. Vitest/MSW, repository typecheck, lint, build and full suites were
**not run**. The preinstalled TypeScript 5.8.3 transpiler reported no syntax
errors across the new TS/TSX files; that is not semantic typechecking against
the repository's dependencies. No real-browser 320px/layout, keyboard or native
picker test, live backend upload test, or MCP test was run. The 320px test wrapper
is not claimed as visual layout proof because jsdom does not perform layout.
