import { describe, expect, it } from 'vitest'
import { CrossComputerCiInputSchema } from './helpers/crossComputerCiInput.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const main = { name: 'Main', hostRef: { kind: 'main', mainId }, registration: null }
const dexter = {
  name: 'Dexter', hostRef: { kind: 'device', mainId, deviceId: '22222222-2222-4222-8222-222222222222' },
  registration: { workerInstallationId: '33333333-3333-4333-8333-333333333333',
    keyRevision: 1, authorizationRevision: 1 },
}
const input = {
  endpoint: 'http://127.0.0.1:3150/mcp', token: 'test-writer', deniedToken: 'test-reader',
  evidenceDirectory: '/tmp/cross-computer-ci',
  workspaces: [
    { workspaceId: 'graphql', project: 'graphql', computers: [main, dexter] },
    { workspaceId: 'demo', project: 'demo', computers: [main, dexter] },
  ],
}

describe('cross-computer CI fixture', () => {
  it('accepts Main and Dexter without requiring an additional excluded computer', () => {
    const parsed = CrossComputerCiInputSchema.parse(input)
    expect(parsed.workspaces[0]?.computers).toHaveLength(2)
    expect(parsed.excludedComputers).toEqual([])
  })

  it('accepts adding mana to the same scenario', () => {
    const value = structuredClone(input)
    value.workspaces[0]!.computers.push({ ...dexter, name: 'mana',
      hostRef: { ...dexter.hostRef, deviceId: '44444444-4444-4444-8444-444444444444' } })
    expect(CrossComputerCiInputSchema.parse(value).workspaces[0]?.computers).toHaveLength(3)
  })

  it('rejects a single computer, duplicated computer, or unregistered Worker', () => {
    const one = structuredClone(input)
    one.workspaces[0]!.computers = [main]
    expect(CrossComputerCiInputSchema.safeParse(one).success).toBe(false)
    const duplicate = structuredClone(input)
    duplicate.workspaces[0]!.computers = [main, main]
    expect(CrossComputerCiInputSchema.safeParse(duplicate).success).toBe(false)
    const unregistered = structuredClone(input)
    unregistered.workspaces[0]!.computers[1] = { ...dexter, registration: null }
    expect(CrossComputerCiInputSchema.safeParse(unregistered).success).toBe(false)
  })

  it('rejects unknown input fields and credentials in the endpoint', () => {
    expect(CrossComputerCiInputSchema.safeParse({ ...input, bypass: true }).success).toBe(false)
    expect(CrossComputerCiInputSchema.safeParse({ ...input, endpoint: 'http://secret@127.0.0.1:3150/mcp' }).success)
      .toBe(false)
  })
})
