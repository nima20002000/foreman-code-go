import { describe, expect, it } from 'vitest'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { ciPreparationFixture as fixture, qualifiedPreparationProfile, dexter, oldImage, newImage, commit, newPin }
  from './helpers/ciPreparationFixture.js'

describe('build computer CI runtime preparation over the authenticated MCP endpoint', () => {
  it('prepares the computer, moves its profiles to the new image and root, refreshes it and requalifies them', async () => {
    const f = await fixture()
    try {
      const started = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-1' })
      expect(started.isError).not.toBe(true)
      expect(BuildComputerPrepareStatusSchema.parse(started.structuredContent)).toMatchObject({ deviceId: dexter, state: 'approving' })
      const done = await f.settle('p-install')
      expect(done).toMatchObject({ state: 'qualified', commit, deviceId: dexter, message: null })
      expect(done.profiles.map(value => [value.profileId, value.status]).sort()).toEqual([['p-install', 'qualified'], ['p-unit', 'qualified']])
      // The computer keeps the image and qualification source its current runtime still uses.
      expect(f.calls.prepare).toEqual([{ repository: '/clones/octo/site', commit, installer: '/ci/managed/installer', keepImages: [oldImage],
        keepPaths: ['/ci/managed/installer/qualification-source-aaaaaaaaaaaa'] }])
      expect(f.calls.bind).toEqual([expect.objectContaining({ source: newPin, expectedBindingRevision: 1, accessMode: 'exclusive-write' })])
      expect(f.calls.saves.map(value => [value.id, value.spec.bindingRevision, value.spec.policy.imageDigest]).sort())
        .toEqual([['p-install', 2, newImage], ['p-unit', 2, newImage]])
      expect(f.calls.refresh).toEqual([expect.objectContaining({ stateDirectory: '/ci/state', root: expect.objectContaining({ source: newPin }),
        resources: expect.objectContaining({ limits: expect.objectContaining({ cpuLimit: 4 }) }) })])
      expect(f.calls.qualified.sort()).toEqual(['p-install', 'p-unit'])
      // Readback: Mana's profile was not touched; Dexter's carry the commit.
      expect(f.profiles.get('p-mana')).toMatchObject({ revision: 3, spec: { policy: { imageDigest: oldImage } } })
      expect(f.profiles.get('p-small')).toMatchObject({ revision: 3, spec: { policy: { imageDigest: oldImage } } })
      expect(f.profiles.get('p-unit')).toMatchObject({ revision: 4, status: 'qualified', sourceCommit: commit })
      expect(f.audits).toContainEqual({ principalId: f.operator.id, action: 'build_computer_prepare', outcome: 'succeeded' })
    } finally { await f.app.close() }
  })

  it('reports the computer\'s failure and leaves its profiles unchanged', async () => {
    const f = await fixture({ prepareFails: true })
    try {
      await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-2' })
      const done = await f.settle('p-unit')
      expect(done).toMatchObject({ state: 'failed', commit })
      expect(done.message).toContain('no space left on device')
      expect(f.calls.saves).toEqual([])
      expect(f.calls.refresh).toEqual([])
    } finally { await f.app.close() }
  })

  it('refuses a caller without the workspace grants and records the denial', async () => {
    const f = await fixture()
    try {
      const denied = await f.call('build_computer_prepare', { workspaceId: f.workspaceId, profileId: 'p-unit', commandId: 'prepare-3' }, 'readonly')
      expect(denied.isError).toBe(true)
      expect(f.calls.prepare).toEqual([])
      expect(f.audits).toContainEqual({ principalId: f.readonly.id, action: 'build_computer_prepare', outcome: 'denied' })
    } finally { await f.app.close() }
  })
})

describe('runtime preparation ownership and recovery', () => {
  it('leaves computers with disabled build participation untouched', async () => {
    const f = await fixture({ disabled: true })
    try {
      await f.ciRuntime.prepareForCommit(f.operator, f.workspaceId, 'unit', commit)
      expect(f.calls.prepare).toEqual([])
      expect(f.memory.records.size).toBe(0)
      const denied = await f.call('build_computer_prepare', {
        workspaceId: f.workspaceId, profileId: 'p-unit', commit, commandId: 'disabled' })
      expect(denied.isError).toBe(true)
      expect(f.calls.saves).toEqual([])
      expect(f.calls.refresh).toEqual([])
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })

  it('reports busy for a newer commit and accepts the same command once the owner finishes', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ pause: stage => stage === 'source' ? paused : Promise.resolve() })
    try {
      await f.ciRuntime.start(f.operator, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'first' })
      const next = { workspaceId: f.workspaceId, profileId: 'p-unit', commit: 'd'.repeat(40), commandId: 'next' }
      await expect(f.ciRuntime.start(f.operator, 'mcp', next)).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
      release()
      expect((await f.settle('p-unit')).state).toBe('qualified')
      expect((await f.ciRuntime.start(f.operator, 'mcp', next)).commit).toBe(next.commit)
      expect((await f.settle('p-unit')).commit).toBe(next.commit)
      expect(f.calls.prepare).toHaveLength(2)
    } finally { release(); await f.ciRuntime.close(); await f.app.close() }
  })

  it('allows only one workspace to own preparation on a physical computer, even at the same commit', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ pause: stage => stage === 'source' ? paused : Promise.resolve() })
    const other = f.createProvisioner()
    try {
      const foreign = structuredClone(f.profiles.get('p-unit')!)
      foreign.id = 'p-other'
      foreign.workspaceId = 'another-workspace'
      foreign.root.binding.workspaceId = 'another-workspace'
      f.profiles.set(foreign.id, qualifiedPreparationProfile(foreign))
      await f.ciRuntime.start(f.operator, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'workspace-first' })
      const principal = { ...f.operator, grants: f.operator.grants.map(grant => ({ ...grant, scope: {} })) }
      f.principals.set(principal.id, principal)
      await expect(other.start(principal, 'mcp', { workspaceId: 'another-workspace',
        profileId: 'p-other', commit, commandId: 'workspace-second' })).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
      await other.recover()
      release()
      expect((await f.settle('p-unit')).state).toBe('qualified')
      expect(f.calls.refresh).toHaveLength(1)
      expect(f.memory.records.size).toBe(1)
      expect(await other.get(principal, { workspaceId: 'another-workspace', profileId: 'p-other' }))
        .toMatchObject({ state: 'idle' })
    } finally { release(); await other.close(); await f.ciRuntime.close(); await f.app.close() }
  })

  it.each(['source', 'root', 'profile', 'refresh', 'capture', 'qualify'] as const)(
    'recovers after Main stops following the committed %s command', async stage => {
      let reached!: () => void
      const atStage = new Promise<void>(resolve => { reached = resolve })
      let release!: () => void
      const paused = new Promise<void>(resolve => { release = resolve })
      let stopped = false
      const f = await fixture({ pause: async current => {
        if (current === stage && !stopped) { reached(); await paused }
      } })
      let recovered: ReturnType<typeof f.createProvisioner> | undefined
      try {
        const input = { workspaceId: f.workspaceId, profileId: 'p-unit', commit, commandId: `restart-${stage}` }
        await f.ciRuntime.start(f.operator, 'mcp', input)
        await atStage
        stopped = true
        const closing = f.ciRuntime.close()
        release()
        await closing
        recovered = f.createProvisioner()
        expect((await recovered.get(f.operator, { workspaceId: f.workspaceId, profileId: 'p-unit' })).state)
          .not.toBe('idle')
        await recovered.recover()
        const done = await f.settle('p-unit', recovered)
        expect(done).toMatchObject({ state: 'qualified', commit })
        expect(await recovered.start(f.operator, 'mcp', input)).toEqual(done)
        expect(f.calls.prepare).toHaveLength(1)
        expect(f.calls.refresh).toHaveLength(1)
        expect(f.calls.saves).toHaveLength(2)
        expect(f.calls.qualified.sort()).toEqual(['p-install', 'p-unit'])
        expect(f.memory.records.size).toBe(1)
      } finally { release(); await recovered?.close(); await f.ciRuntime.close(); await f.app.close() }
    })

  it.each([{ statusDrops: 1 }, { loseRefreshAck: true }])('reconciles a temporary channel failure: %j', async options => {
    const f = await fixture(options)
    try {
      await f.ciRuntime.start(f.operator, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'disconnect' })
      expect(await f.settle('p-unit')).toMatchObject({ state: 'qualified', commit })
      expect(f.calls.prepare).toHaveLength(1)
      expect(f.calls.refresh).toHaveLength(1)
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })

  it('does not gain missing preparation grants when the stored Operator grants are broader', async () => {
    const f = await fixture()
    try {
      const caller = { ...f.operator, grants: f.operator.grants.map(grant => ({ ...grant,
        actions: grant.actions.filter(action => action !== 'job_artifacts:read') })) }
      await expect(f.ciRuntime.start(caller, 'mcp', { workspaceId: f.workspaceId,
        profileId: 'p-unit', commit, commandId: 'limited' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(f.calls.prepare).toEqual([])
      expect(f.memory.records.size).toBe(0)
    } finally { await f.ciRuntime.close(); await f.app.close() }
  })
})
