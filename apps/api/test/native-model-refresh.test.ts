import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessOptionsResultSchema } from '@graphql/contracts/management'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function fixture(version: string, refreshExit = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-model-refresh-'))
  directories.push(directory)
  const binary = join(directory, 'opencode')
  const calls = join(directory, 'calls')
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }
if (process.argv[2] === 'models' && process.argv[3] === '--refresh' && process.argv[4] === '--pure') process.exit(${refreshExit})
process.exit(1)
`)
  await chmod(binary, 0o700)
  const service = new NativeConfigurationService('unused', binary, directory)
  const catalog = HarnessOptionsResultSchema.parse({ harness: 'opencode', providerVersion: '1.18.31',
    authenticated: true, models: [], nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString() })
  const options = vi.spyOn(service, 'options').mockResolvedValue(catalog)
  return { service, calls, options, catalog }
}

it('only an explicit OpenCode upstream refresh runs the qualified CLI cache update', async () => {
  const { service, calls, options, catalog } = await fixture('1.18.31')
  expect(await service.refreshOptions('opencode', 'catalog')).toEqual(catalog)
  await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await service.refreshOptions('opencode', 'upstream')).toEqual(catalog)
  expect(await readFile(calls, 'utf8')).toBe('--version\nmodels --refresh --pure\n')
  expect(options).toHaveBeenCalledTimes(2)
})

it('rejects an unqualified OpenCode version before updating its cache', async () => {
  const { service, calls, options } = await fixture('1.18.30')
  await expect(service.refreshOptions('opencode', 'upstream')).rejects.toMatchObject({ code: 'OPENCODE_SERVER_VERSION_UNQUALIFIED' })
  expect(await readFile(calls, 'utf8')).toBe('--version\n')
  expect(options).not.toHaveBeenCalled()
})

it('does not offer an upstream cache update for Codex', async () => {
  const { service, calls, options } = await fixture('1.18.31')
  await expect(service.refreshOptions('codex', 'upstream')).rejects.toMatchObject({ code: 'CODEX_MODEL_REFRESH_UNSUPPORTED' })
  await expect(readFile(calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(options).not.toHaveBeenCalled()
})

it('fails closed when OpenCode cannot update the upstream cache', async () => {
  const { service, options } = await fixture('1.18.31', 1)
  const invalidate = vi.spyOn(service, 'invalidateOptions')
  await expect(service.refreshOptions('opencode', 'upstream')).rejects.toMatchObject({ code: 'OPENCODE_MODEL_REFRESH_UNAVAILABLE' })
  expect(invalidate).toHaveBeenCalledOnce()
  expect(options).not.toHaveBeenCalled()
})
