import { describe, expect, it } from 'vitest'
import type { QualificationSuiteInput } from '../types.js'
import { collectChecks } from './checks.js'

const input = { binary: '/tmp/candidate', version: '1.2.3', binarySha256: 'a'.repeat(64),
  profile: 'codex-0.156', model: null, workDirectory: '/tmp/qualification',
  signal: new AbortController().signal } satisfies QualificationSuiteInput

describe('qualification check aggregation', () => {
  it('records failures and still runs independent later checks', async () => {
    const visited: string[] = []
    const result = await collectChecks(input, [
      ['version', async () => { visited.push('version'); return 'candidate' }],
      ['schema', async () => { visited.push('schema'); throw new Error('Unsupported schema') }],
      ['health', async () => { visited.push('health'); return null }],
    ], { sha256: input.binarySha256 })
    expect(visited).toEqual(['version', 'schema', 'health'])
    expect(result.checks).toEqual([
      { id: 'version', passed: true, detail: 'candidate' },
      { id: 'schema', passed: false, detail: 'Unsupported schema' },
      { id: 'health', passed: true, detail: null },
    ])
    expect(result.evidence).toEqual({ sha256: input.binarySha256 })
  })

  it('bounds error details and never passes an aborted check', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Canceled'))
    let ran = false
    const result = await collectChecks({ ...input, signal: controller.signal }, [
      ['stopped', async () => { ran = true; return 'incorrect' }],
    ])
    expect(ran).toBe(false)
    expect(result.checks).toEqual([{ id: 'stopped', passed: false, detail: 'Canceled' }])
    const long = await collectChecks(input, [['long', async () => { throw new Error('x'.repeat(600)) }]])
    expect(long.checks[0]?.detail?.length).toBe(500)
  })
})
