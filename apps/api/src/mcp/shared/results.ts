import type { CallToolResult } from '@modelcontextprotocol/server'

import { DomainError } from '../../modules/errors.js'

export function toolResult(value: unknown): CallToolResult {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
  const json = JSON.stringify(structuredContent)
  // Large results (e.g. accepted inputs) are carried once, in structuredContent;
  // duplicating them as text would double the response past its byte budget.
  const text = Buffer.byteLength(json, 'utf8') <= TEXT_MIRROR_BYTES ? json
    : JSON.stringify({ note: 'Result exceeds the text mirror limit; the complete exact value is in structuredContent.',
      bytes: Buffer.byteLength(json, 'utf8') })
  return { content: [{ type: 'text', text }], structuredContent }
}
export const TEXT_MIRROR_BYTES = 256 * 1024

export function toolFailure(error: unknown, internalMessage = 'The Operator service could not complete the request.'): CallToolResult {
  const body = error instanceof DomainError
    ? { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
    : { error: { code: 'INTERNAL_ERROR', message: internalMessage } }
  // No structuredContent: it must match the tool's success outputSchema, and
  // clients such as OpenCode validate it even on isError, masking the error.
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }
}
