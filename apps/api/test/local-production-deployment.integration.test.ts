import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { removeFixtureDirectory } from './helpers/testResources.js'

it('keeps source development commands usable after successful and failed production deployment', async () => {
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { deployProductionApi } = await import(script)
  const execute = promisify(execFile)
  const directory = await mkdtemp(join(tmpdir(), 'production-deployment-'))
  const source = join(directory, 'workspace')
  const api = join(source, 'apps/api')
  const destination = join(directory, 'deployed')
  const environment = { ...process.env }
  delete environment.CI
  delete environment.NODE_ENV
  const run = (command: string, args: string[]) => execute(command, args, {
    cwd: source, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  })
  const verifyDevelopment = async () => {
    const { stdout } = await run('corepack', ['pnpm', 'run', 'verify-development'])
    expect(stdout).toContain('development dependency available')
  }
  try {
    await mkdir(join(api, 'dist'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'production-deployment-fixture', private: true, version: '1.0.0',
      packageManager: 'pnpm@11.27.0',
      devDependencies: { '@types/node': '26.5.1' },
      scripts: { 'verify-development': 'node -e "require(\'@types/node/package.json\'); console.log(\'development dependency available\')"' },
    }))
    await writeFile(join(source, 'pnpm-workspace.yaml'), [
      'packages:', '  - apps/*', 'sharedWorkspaceLockfile: true', 'autoInstallPeers: false',
      'minimumReleaseAge: 2880', 'minimumReleaseAgeStrict: true',
      'minimumReleaseAgeIgnoreMissingTime: false', 'verifyDepsBeforeRun: install',
    ].join('\n') + '\n')
    await writeFile(join(api, 'package.json'), JSON.stringify({
      name: '@foreman-code/api', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'],
    }))
    await writeFile(join(api, 'dist/index.js'), 'export const deployed = () => "production API available"\n')
    await run('corepack', ['pnpm', 'install'])
    await verifyDevelopment()
    await deployProductionApi(run, destination)
    const deployed = await import(pathToFileURL(join(destination, 'dist/index.js')).href)
    expect(deployed.deployed()).toBe('production API available')
    await verifyDevelopment()
    const blockedDestination = join(directory, 'occupied')
    await writeFile(blockedDestination, 'occupied')
    await expect(deployProductionApi(run, blockedDestination)).rejects.toThrow()
    await verifyDevelopment()
  } finally {
    await removeFixtureDirectory(directory)
  }
}, 180_000)
