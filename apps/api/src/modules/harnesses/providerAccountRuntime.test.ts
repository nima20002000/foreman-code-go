import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { resolveRuntimeProviderAccount, managedProviderEnvironment } from './providerAccountRuntime.js'
import type { ResolvedProviderAccount } from '../provider-accounts/service.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function bound(): ResolvedProviderAccount {
  const id = randomUUID()
  const binding: ProviderAccountBinding = { kind: 'slot', provider: 'codex', accountId: id,
    target: { hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
      keyRevision: null, authorizationRevision: null }, profileRef: randomUUID(), bindingRevision: 1, subject: null }
  return { accountId: id, homePath: '/selected/profile', authMode: 'subscription', binding }
}
async function scopes() {
  const root = await mkdtemp(join(tmpdir(), 'account-runtime-'))
  roots.push(root)
  return { first: { root: join(root, 'processes'), owner: 'session:first' },
    second: { root: join(root, 'processes'), owner: 'session:second' } }
}

describe('accepted provider account runtime', () => {
  it('uses the complete accepted binding and never resolves a new default during cold recovery', async () => {
    const value = bound()
    const resolve = vi.fn().mockResolvedValue(value)
    const { first } = await scopes()
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', value.accountId, first, undefined, value.binding))
      .toEqual(value)
    resolve.mockClear()
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first)).toEqual(value)
    expect(resolve).toHaveBeenCalledWith('codex', value.accountId, { allowDefault: false, acceptedBinding: value.binding })
  })

  it('keeps a missing historical sidecar on the legacy profile without querying a default', async () => {
    const resolve = vi.fn().mockResolvedValue(bound())
    const { first } = await scopes()
    expect(await resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first)).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects explicit selection conflicting with either stored or source binding before a lookup', async () => {
    const value = bound()
    const other = bound()
    const resolve = vi.fn().mockResolvedValue(value)
    const { first, second } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', value.accountId, first, undefined, value.binding)
    resolve.mockClear()
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', other.accountId, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', other.accountId, second, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['profileRef', 'bindingRevision', 'target'] as const)('rejects changed %s at native readback', async field => {
    const value = bound()
    const original = structuredClone(value.binding!)
    const resolve = vi.fn().mockResolvedValue(value)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', value.accountId, first, undefined, original)
    if (field === 'bindingRevision') value.binding!.bindingRevision++
    else if (field === 'target') value.binding!.target.applicationInstallationId = randomUUID()
    else value.binding!.profileRef = randomUUID()
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
  })

  it('fails on a missing or tombstoned slot without an ambient fallback', async () => {
    const value = bound()
    const resolve = vi.fn().mockResolvedValue(value)
    const { first } = await scopes()
    await resolveRuntimeProviderAccount({ resolve }, 'codex', value.accountId, first, undefined, value.binding)
    resolve.mockResolvedValue(null)
    await expect(resolveRuntimeProviderAccount({ resolve }, 'codex', undefined, first))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
  })

  it('preserves Claude HOME and explicit API-key mode in the private environment', () => {
    const value = { ...bound(), authMode: 'api-key' as const, apiKey: 'local-test-key' }
    expect(managedProviderEnvironment({ HOME: '/human-context', ANTHROPIC_AUTH_TOKEN: 'ambient' }, value, 'claude'))
      .toEqual({ HOME: '/human-context', CLAUDE_CONFIG_DIR: value.homePath, ANTHROPIC_API_KEY: 'local-test-key' })
  })
})
