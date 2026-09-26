import type { CallToolResult } from '@modelcontextprotocol/server'

import { DomainError } from '../../modules/errors.js'

export function toolResult(value: unknown): CallToolResult {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

export function toolFailure(error: unknown, internalMessage = 'The Operator service could not complete the request.'): CallToolResult {
  const body = error instanceof DomainError
    ? { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
    : { error: { code: 'INTERNAL_ERROR', message: internalMessage } }
  // No structuredContent: it must match the tool's success outputSchema, and
  // clients such as OpenCode validate it even on isError, masking the error.
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }
}
