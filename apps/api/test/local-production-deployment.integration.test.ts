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
  const contracts = join(source, 'packages/contracts')
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
    await mkdir(join(contracts, 'dist'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'production-deployment-fixture', private: true, version: '1.0.0',
      packageManager: 'pnpm@11.27.0',
      devDependencies: { '@types/node': '26.5.1' },
      scripts: { 'verify-development': 'node -e "require(\'@types/node/package.json\'); console.log(\'development dependency available\')"' },
    }))
    await writeFile(join(source, 'pnpm-workspace.yaml'), [
      'packages:', '  - apps/*', '  - packages/*', 'sharedWorkspaceLockfile: true', 'autoInstallPeers: false',
      'minimumReleaseAge: 2880', 'minimumReleaseAgeStrict: true',
      'minimumReleaseAgeIgnoreMissingTime: false', 'verifyDepsBeforeRun: install',
    ].join('\n') + '\n')
    await writeFile(join(api, 'package.json'), JSON.stringify({
      name: '@foreman-code/api', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'], dependencies: {
        '@foreman-code/contracts': 'workspace:*', '@modelcontextprotocol/client': '2.0.0',
      },
    }))
    await writeFile(join(contracts, 'package.json'), JSON.stringify({ name: '@foreman-code/contracts',
      private: true, version: '1.0.0', type: 'module', main: 'dist/index.js', files: ['dist'] }))
    await writeFile(join(contracts, 'dist/index.js'), 'export const contractValue = () => "production API available"\n')
    await writeFile(join(api, 'dist/index.js'),
      'import { Client } from "@modelcontextprotocol/client";\n'
      + 'import { contractValue } from "@foreman-code/contracts";\n'
      + 'export async function deployed() {\n'
      + '  const client = new Client({ name: "production-deployment-fixture", version: "1.0.0" });\n'
      + '  await client.close();\n'
      + '  return contractValue();\n'
      + '}\n')
    await run('corepack', ['pnpm', 'install'])
    await verifyDevelopment()
    await deployProductionApi(run, destination)
    const deployed = await import(pathToFileURL(join(destination, 'dist/index.js')).href)
    expect(await deployed.deployed()).toBe('production API available')
    await writeFile(join(contracts, 'dist/index.js'), 'export const contractValue = () => "rebuilt contracts"\n')
    await writeFile(join(api, 'dist/index.js'), 'export const deployed = () => "rebuilt source API"\n')
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      'const module = await import(process.argv[1]); console.log(await module.deployed());',
      pathToFileURL(join(destination, 'dist/index.js')).href])
    expect(stdout.trim()).toBe('production API available')
    await verifyDevelopment()
    const blockedDestination = join(directory, 'occupied')
    await writeFile(blockedDestination, 'occupied')
    await expect(deployProductionApi(run, blockedDestination)).rejects.toThrow()
    await verifyDevelopment()
  } finally {
    await removeFixtureDirectory(directory)
  }
}, 180_000)
