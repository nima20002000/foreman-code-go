import { describe, expect, it } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { deliverableFailure, deliverableRepairPrompt, deliverableVerdict, nativeOutputSchema, type DeliverableContract } from './deliverable.js'

const known = new Set(['ticket-created-here'])
const contract = (over: Partial<DeliverableContract> = {}): DeliverableContract => ({
  source: 'text', referencesExist: async (_kind, values) => new Set(values.filter(value => known.has(value))), ...over,
})
const finalText = (text: string): ExecutionResult => ({ outcome: 'succeeded', output: { text } })
const schema = {
  type: 'object', required: ['status', 'summary'],
  properties: { status: { type: 'string', minLength: 1 }, summary: { type: 'string', minLength: 1 },
    ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } },
}

describe('deliverable verdict', () => {
  it('passes a non-blank plain answer and rejects a blank one under the default rule', async () => {
    expect(await deliverableVerdict(finalText('Reviewed the diff.'), contract())).toBeUndefined()
    expect(await deliverableVerdict(finalText('  '), contract())).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
  })

  it('does not judge a failed result', async () => {
    expect(await deliverableVerdict({ outcome: 'failed', error: { code: 'X', message: 'x', retryable: false } }, contract())).toBeUndefined()
  })

  it('requires a declared schema to hold for JSON text and reports the exact paths', async () => {
    const verdict = await deliverableVerdict(finalText('{"status":"done"}'), contract({ outputSchema: schema }))
    expect(verdict?.code).toBe('OUTPUT_SCHEMA_MISMATCH')
    expect(verdict?.issues.map(issue => issue.path)).toContain('/summary')
    expect(await deliverableVerdict(finalText('```json\n{}\n```'), contract({ outputSchema: schema }))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(finalText('{"status":"done","summary":"Shipped."}'), contract({ outputSchema: schema }))).toBeUndefined()
  })

  it('verifies references only after the shape passes, reporting OUTPUT_REFERENCE_UNKNOWN', async () => {
    const answer = (ticket: string) => finalText(JSON.stringify({ status: 'done', summary: 'ok', ticket }))
    expect(await deliverableVerdict(answer('ticket-created-here'), contract({ outputSchema: schema }))).toBeUndefined()
    expect(await deliverableVerdict(answer('someone-else'), contract({ outputSchema: schema })))
      .toMatchObject({ code: 'OUTPUT_REFERENCE_UNKNOWN', issues: [{ code: 'OUTPUT_REFERENCE_UNKNOWN', path: '/ticket' }] })
  })

  it('reads latestDeliverable from the native text envelope and leaves a malformed envelope to routing validation', async () => {
    const envelope = (latestDeliverable: unknown) => finalText(JSON.stringify({ routing: { kind: 'finish' }, data: { latestDeliverable, remainingFindings: [] } }))
    const source = { source: 'latestDeliverable' as const }
    expect(await deliverableVerdict(envelope({ status: 'done', summary: 'ok' }), contract({ ...source, outputSchema: schema }))).toBeUndefined()
    expect(await deliverableVerdict(envelope({}), contract(source))).toBeUndefined()
    expect(await deliverableVerdict(envelope(null), contract(source))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(finalText('not an envelope'), contract({ ...source, outputSchema: schema }))).toBeUndefined()
  })

  it('checks choice data only against a declared schema, since the choice contract allows null data', async () => {
    const choice = (data: unknown) => finalText(JSON.stringify({ routing: { outcome: 'approve' }, data }))
    expect(await deliverableVerdict(choice(null), contract({ source: 'data' }))).toBeUndefined()
    expect(await deliverableVerdict(choice(null), contract({ source: 'data', outputSchema: schema }))).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(await deliverableVerdict(choice({ status: 'done', summary: 'ok' }), contract({ source: 'data', outputSchema: schema }))).toBeUndefined()
  })
})

describe('deliverable repair and failure', () => {
  it('lists every validation issue exactly in the corrective turn', async () => {
    const verdict = await deliverableVerdict(finalText('{}'), contract({ outputSchema: schema }))
    const prompt = deliverableRepairPrompt(verdict!, schema)
    expect(prompt).toContain(JSON.stringify(verdict!.issues))
    expect(prompt).toContain('same execution')
  })

  it('fails loudly with a non-retryable result carrying the code and every issue', async () => {
    const verdict = await deliverableVerdict(finalText('{}'), contract({ outputSchema: schema }))
    expect(deliverableFailure(verdict!)).toMatchObject({ outcome: 'failed', error: { code: 'OUTPUT_SCHEMA_MISMATCH', retryable: false } })
  })

  it('sends Codex native structured output only for strict plain-answer schemas, without reference markers', () => {
    const strict = { type: 'object', additionalProperties: false, required: ['status', 'ticket'],
      properties: { status: { type: 'string' }, ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } } }
    expect(nativeOutputSchema(contract({ outputSchema: strict }))).toEqual({ type: 'object', additionalProperties: false,
      required: ['status', 'ticket'], properties: { status: { type: 'string' }, ticket: { type: 'string' } } })
    expect(nativeOutputSchema(contract({ outputSchema: schema }))).toBeUndefined()
    expect(nativeOutputSchema(contract({ source: 'data', outputSchema: strict }))).toBeUndefined()
    expect(nativeOutputSchema(contract())).toBeUndefined()
  })
})
