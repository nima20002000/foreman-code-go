import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import { installedRestartService } from './helpers/installedRestartService.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { useInstalledRestartFixture } from './helpers/installedRestartFixture.js'

describe('installed Main-local workflows across systemd restart', () => {
  let fixture: Awaited<ReturnType<typeof installationUpdateFixture>> | undefined
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const readBuildIdentity = () => fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
    headers: { authorization: `Bearer ${fixture!.writer.token}` },
  })

  const installedFixture = useInstalledRestartFixture()
  beforeAll(() => { fixture = installedFixture() })

  it('starts an installed API on a fresh user service setup', async () => {
    expect(await fixture!.mainService!.state()).toBe('active')
    const pid = await fixture!.mainService!.pid()
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).not.toThrow()
    const health = await fetch(new URL('/health/live', fixture!.origin()))
    expect(health.status).toBe(200)
  })

  it('rejects an invalid credential when reading the packaged build identity', async () => {
    const response = await fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
      headers: { authorization: 'Bearer invalid-fixture-credential' },
    })
    expect(response.status).toBe(401)
  })

  it('serves its packaged build identity without requiring a source checkout', async () => {
    const response = await readBuildIdentity()
    expect(response.status).toBe(200)
    const identity = RuntimeBuildIdentitySchema.parse(await response.json())
    expect(identity).toEqual(createRuntimeBuildIdentity(repository))
  })
})

describe('installed API fixture packaging', () => {
  it('deploys offline using the package store that populated the workspace', async () => {
    const directory = await privateFixtureDirectory('installed-packaging-')
    const bin = join(directory, 'bin')
    const calls = join(directory, 'calls.json')
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
      storeDir: string
    }
    await mkdir(bin)
    await writeFile(join(bin, 'corepack'), `#!${process.execPath}
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)))
console.error('Fixture package store is intentionally empty')
process.exit(1)
`, { mode: 0o700 })
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`)
    // A separate cache forces deployment even when another installed fixture is already warm.
    vi.stubEnv('FOREMAN_CODE_TEST_CACHE_ROOT', join(directory, 'cache'))
    try {
      await expect(installedRestartService(directory, join(directory, 'config.json'), {}, join(directory, 'runtime')))
        .rejects.toThrow('Fixture package store is intentionally empty')
      const args = JSON.parse(await readFile(calls, 'utf8')) as string[]
      expect(args).toContain('--offline')
      expect(args[args.indexOf('--store-dir') + 1]).toBe(storeDir)
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
