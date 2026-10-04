/** Worker-safe counterpart of the existing Main command canonical digest. */
import { createHash } from 'node:crypto'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { MaterializationAttempt } from './ports.js'
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export function sourceOperationSelectionHash(root: SourceRootRecord, attempt: MaterializationAttempt, operationId: string): string {
  return createHash('sha256').update(canonical({ version: 1, source: root.source, root: { selection: root.selection,
    binding: root.binding, registration: root.registration, attestationId: root.attestationId, attestationDigest: root.attestationDigest },
  executionId: attempt.executionId, attemptId: attempt.attemptId, operationId, keyRevision: attempt.keyRevision, authorizationRevision: attempt.authorizationRevision })).digest('hex')
}
