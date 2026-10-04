import { createHash } from 'node:crypto'
import {
  McpInteractionSummarySchema,
  type DurableInteraction,
} from '@graphql/contracts'
import { z } from 'zod'
import { toolResult } from '../../mcp/shared/results.js'
import { DomainError } from '../errors.js'

// Includes both JSON representations and escaping, with room for HTTP/SSE framing and the RPC id.
export const INTERACTION_MCP_RESPONSE_BYTES = 384 * 1024
// Stay below OpenCode's default tool-text truncation so options and cursors reach the model.
export const INTERACTION_MCP_TEXT_BYTES = 24 * 1024
const CHUNK_CHARACTERS = 8192
const ContentCursorSchema = z.object({
  interactionId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative(),
}).strict()

export function fitsInteractionMcpResponse(value: unknown): boolean {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > INTERACTION_MCP_TEXT_BYTES) return false
  const envelope = { jsonrpc: '2.0', id: 'x'.repeat(1000), result: toolResult(value) }
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= INTERACTION_MCP_RESPONSE_BYTES
}

export function interactionMcpSummary(interaction: DurableInteraction) {
  const { id, revision, workspaceId, workflowId, runId, executionId, harness, status,
    deliveryState, approval } = interaction
  const responseOptions: DurableInteraction['responseOptions'] = []
  for (const option of interaction.responseOptions) {
    if (Buffer.byteLength(JSON.stringify([...responseOptions, option]), 'utf8') > 16 * 1024) break
    responseOptions.push(option)
  }
  return McpInteractionSummarySchema.parse({
    id, revision, workspaceId, workflowId, runId, executionId, harness, status, deliveryState, approval,
    ...(interaction.selectedOptionId ? { selectedOptionId: interaction.selectedOptionId } : {}),
    ...(interaction.selectedSemantic ? { selectedSemantic: interaction.selectedSemantic } : {}),
    ...(interaction.decidedAt ? { decidedAt: interaction.decidedAt } : {}),
    ...(interaction.deliveredAt ? { deliveredAt: interaction.deliveredAt } : {}),
    responseOptions, responseOptionsComplete: responseOptions.length === interaction.responseOptions.length,
    contentOmitted: true, retrieval: { tool: 'interaction_get', interactionId: id },
  })
}

export function interactionMcpView(interaction: DurableInteraction) {
  return fitsInteractionMcpResponse({ interaction }) ? interaction : interactionMcpSummary(interaction)
}

export function interactionMcpGet(
  value: { interaction: DurableInteraction; activity?: unknown }, contentCursor?: string,
) {
  if (!contentCursor && fitsInteractionMcpResponse(value)) return value
  const json = JSON.stringify(value)
  const sha256 = createHash('sha256').update(json).digest('hex')
  let offset = 0
  if (contentCursor) {
    let cursor: z.infer<typeof ContentCursorSchema>
    try {
      cursor = ContentCursorSchema.parse(JSON.parse(Buffer.from(contentCursor, 'base64url').toString('utf8')))
    } catch {
      throw new DomainError('INVALID_CURSOR', 'The interaction content cursor is invalid.', 400)
    }
    if (cursor.interactionId !== value.interaction.id || cursor.sha256 !== sha256) {
      throw new DomainError('INTERACTION_CONTENT_CHANGED', 'The interaction content changed. Read it again without a content cursor.', 409)
    }
    offset = cursor.offset
    if (offset >= json.length || isSurrogateBoundary(json, offset)) {
      throw new DomainError('INVALID_CURSOR', 'The interaction content cursor is invalid.', 400)
    }
  }
  const interaction = interactionMcpSummary(value.interaction)
  let length = CHUNK_CHARACTERS
  while (length > 0) {
    let end = Math.min(offset + length, json.length)
    if (isSurrogateBoundary(json, end)) end--
    const nextCursor = end < json.length ? Buffer.from(JSON.stringify({
      interactionId: value.interaction.id, sha256, offset: end,
    })).toString('base64url') : null
    const result = {
      interaction,
      content: { format: 'json' as const, text: json.slice(offset, end), totalCharacters: json.length, sha256, nextCursor },
    }
    if (end > offset && fitsInteractionMcpResponse(result)) return result
    length = Math.floor(length / 2)
  }
  throw new DomainError('INTERACTION_METADATA_TOO_LARGE', 'The interaction metadata exceeds the MCP response budget.', 413)
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}
