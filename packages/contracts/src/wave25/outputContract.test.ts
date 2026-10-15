import { describe, expect, it } from 'vitest'
import {
  OutputSchemaSchema, NodeSkillOverrideSchema, checkDeliverable, deliverableReferences, OUTPUT_SCHEMA_MAX_BYTES,
} from './outputContract.js'

const statusSummary = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
  },
}

describe('workflow Agent output schema', () => {
  it('accepts a JSON Schema with a ciTicket reference marker on a string property', () => {
    const schema = { type: 'object', properties: { ticket: { type: 'string', 'x-foreman-reference': 'ciTicket' } } }
    expect(OutputSchemaSchema.parse(schema)).toEqual(schema)
  })

  it('rejects unknown reference kinds, markers on non-string values, remote refs and oversized schemas', () => {
    expect(OutputSchemaSchema.safeParse({ properties: { t: { type: 'string', 'x-foreman-reference': 'run' } } }).success).toBe(false)
    expect(OutputSchemaSchema.safeParse({ properties: { t: { type: 'number', 'x-foreman-reference': 'ciTicket' } } }).success).toBe(false)
    expect(OutputSchemaSchema.safeParse({ $ref: 'https://example.com/schema.json' }).success).toBe(false)
    const oversized = { type: 'string', description: 'x'.repeat(OUTPUT_SCHEMA_MAX_BYTES) }
    expect(OutputSchemaSchema.safeParse(oversized).success).toBe(false)
  })

  it('accepts exact added skill versions and removed skill IDs, and rejects a skill named in both lists', () => {
    const override = { add: [{ skillId: 'skill-a', version: '3' }], remove: ['skill-b'] }
    expect(NodeSkillOverrideSchema.parse(override)).toEqual(override)
    expect(NodeSkillOverrideSchema.safeParse({ add: ['skill-a'] }).success).toBe(false)
    expect(NodeSkillOverrideSchema.safeParse({ add: [{ skillId: 'skill-a', version: '3' }], remove: ['skill-a'] }).success).toBe(false)
  })
})

describe('deliverable checks', () => {
  it('requires a present deliverable when no schema is declared', () => {
    expect(checkDeliverable('Finished the review.', undefined)).toEqual([])
    expect(checkDeliverable({}, undefined)).toEqual([])
    expect(checkDeliverable('   ', undefined)).toEqual([expect.objectContaining({ code: 'OUTPUT_SCHEMA_MISMATCH' })])
    expect(checkDeliverable(null, undefined)).toEqual([expect.objectContaining({ code: 'OUTPUT_SCHEMA_MISMATCH' })])
  })

  it('reports every schema violation with its JSON pointer path', () => {
    const issues = checkDeliverable({ status: 'ok' }, statusSummary)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every(issue => issue.code === 'OUTPUT_SCHEMA_MISMATCH' && issue.message.length > 0)).toBe(true)
    expect(issues.map(issue => issue.path)).toContain('/summary')
    expect(checkDeliverable({ status: 'ok', summary: 'Done.' }, statusSummary)).toEqual([])
  })

  it('lists ciTicket references from properties and array items with their values', () => {
    const schema = {
      type: 'object',
      properties: {
        primary: { type: 'string', 'x-foreman-reference': 'ciTicket' },
        related: { type: 'array', items: { type: 'string', 'x-foreman-reference': 'ciTicket' } },
      },
    }
    const deliverable = { primary: 'run-1', related: ['run-2', 'run-3'] }
    expect(deliverableReferences(schema, deliverable)).toEqual([
      { kind: 'ciTicket', value: 'run-1', path: '/primary' },
      { kind: 'ciTicket', value: 'run-2', path: '/related/0' },
      { kind: 'ciTicket', value: 'run-3', path: '/related/1' },
    ])
  })
})
