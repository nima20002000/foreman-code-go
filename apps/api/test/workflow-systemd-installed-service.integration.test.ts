import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { deployProductionApi } from '../../../scripts/local-production-runtime.mjs'
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
  it.each([
    { age: 'old', modified: '2000-01-01T00:00:00.000Z', succeeds: true },
    { age: 'unknown', modified: undefined, succeeds: false },
  ])('deploys locked packages with $age abbreviated metadata without bypassing release age', async ({
    modified, succeeds,
  }) => {
    const directory = await privateFixtureDirectory('locked-packaging-')
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
      storeDir: string
    }
    const lockfile = parse(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
    const dependency = lockfile.importers['apps/api'].dependencies.yaml
    const packageKey = `yaml@${dependency.version}`
    const cache = join(directory, 'metadata')
    const metadata = join(cache, 'v11/metadata/https%3A+registry.npmjs.org')
    const destination = join(directory, 'deployed')
    await mkdir(join(directory, 'apps/api'), { recursive: true })
    await mkdir(metadata, { recursive: true })
    const { packageManager } = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, packageManager }))
    await writeFile(join(directory, 'pnpm-workspace.yaml'), stringify({
      packages: ['apps/*'], autoInstallPeers: false, sharedWorkspaceLockfile: true,
      minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false,
    }))
    await writeFile(join(directory, 'apps/api/package.json'), JSON.stringify({
      name: '@foreman-code/api', version: '1.0.0', dependencies: { yaml: dependency.specifier },
    }))
    await writeFile(join(directory, 'pnpm-lock.yaml'), stringify({
      lockfileVersion: lockfile.lockfileVersion,
      settings: lockfile.settings,
      importers: { '.': {}, 'apps/api': { dependencies: { yaml: dependency } } },
      packages: { [packageKey]: lockfile.packages[packageKey] },
      snapshots: { [packageKey]: lockfile.snapshots[packageKey] },
    }))
    await writeFile(join(metadata, 'yaml.jsonl'), `${JSON.stringify({ modified })}\n${JSON.stringify({
      name: 'yaml', modified, 'dist-tags': { latest: dependency.version },
      versions: { [dependency.version]: {
        name: 'yaml', version: dependency.version,
        dist: { integrity: lockfile.packages[packageKey].resolution.integrity,
          tarball: `https://registry.npmjs.org/yaml/-/yaml-${dependency.version}.tgz` },
      } },
    })}`)
    const execute = promisify(execFile)
    const deploy = deployProductionApi(async (command, args) => {
      // This disposable workspace needs no post-deploy installation restoration.
      if (args.includes('install')) return
      await execute(command, [...args, '--offline', '--store-dir', storeDir, '--cache-dir', cache], {
        cwd: directory, env: { ...process.env, CI: 'true' }, timeout: 30_000,
      })
    }, destination)
    try {
      if (!succeeds) {
        await expect(deploy).rejects.toThrow(/minimumReleaseAge|NO_OFFLINE_META|MISSING_TIME/)
        return
      }
      await deploy
      const deployedRequire = createRequire(join(destination, 'package.json'))
      expect(deployedRequire('yaml').parse('installed: true')).toEqual({ installed: true })
      expect(deployedRequire('yaml/package.json').version).toBe(dependency.version)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

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
