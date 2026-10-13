import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { removeFixtureDirectory } from './helpers/testResources.js'

it('reuses installed dependencies across contracts rebuilds while keeping rollback releases immutable', async () => {
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { deployProductionApi, pruneApiDependencies } = await import(script)
  const execute = promisify(execFile)
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'production-dependency-cache-'))
  const source = join(directory, 'workspace')
  const api = join(source, 'apps/api')
  const contracts = join(source, 'packages/contracts')
  const environment = { ...process.env, npm_config_offline: 'true' }
  let deploys = 0
  const run = async (command: string, args: string[]) => {
    if (args.includes('deploy')) deploys += 1
    return execute(command, args, { cwd: source, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  }
  const callRelease = async (destination: string) => {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      'const api = await import(process.argv[1]); console.log(api.value());',
      pathToFileURL(join(destination, 'dist/index.js')).href])
    return stdout.trim()
  }
  try {
    await mkdir(join(api, 'dist'), { recursive: true })
    await mkdir(join(contracts, 'dist'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'production-cache-fixture', private: true, packageManager: 'pnpm@11.27.0',
    }))
    await writeFile(join(source, 'pnpm-workspace.yaml'), [
      'packages:', '  - apps/*', '  - packages/*', 'autoInstallPeers: false',
      'minimumReleaseAge: 2880', 'minimumReleaseAgeStrict: true', 'minimumReleaseAgeIgnoreMissingTime: false',
    ].join('\n') + '\n')
    await writeFile(join(api, 'package.json'), JSON.stringify({
      name: '@foreman-code/api', private: true, version: '1.0.0', type: 'module', files: ['dist'],
      dependencies: { '@foreman-code/contracts': 'workspace:*', zod: '4.6.3' },
    }))
    await writeFile(join(contracts, 'package.json'), JSON.stringify({
      name: '@foreman-code/contracts', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'], dependencies: { zod: '4.6.3' },
    }))
    const require = createRequire(new URL('../../worker/package.json', import.meta.url))
    const { parse } = require('yaml') as { parse: (text: string) => Record<string, unknown> }
    const lock = parse(await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8'))
    const zod = { specifier: '4.6.3', version: '4.6.3' }
    await writeFile(join(source, 'pnpm-lock.yaml'), JSON.stringify({ ...lock, importers: {
      '.': {}, 'apps/api': { dependencies: {
        '@foreman-code/contracts': { specifier: 'workspace:*', version: 'link:../../packages/contracts' }, zod,
      } }, 'packages/contracts': { dependencies: { zod } },
    } }))
    const buildContracts = async (value: string) => writeFile(join(contracts, 'dist/index.js'),
      `import { z } from 'zod'; export const value = () => z.string().parse(${JSON.stringify(value)});\n`)
    await buildContracts('first contracts')
    await writeFile(join(api, 'dist/index.js'),
      "export { value } from '@foreman-code/contracts';\n")
    await run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
    const dependencies = { root: join(directory, 'api-dependencies'), source }
    const first = join(directory, 'releases/first/apps/api')
    await deployProductionApi(run, first, { dependencies })
    expect(await callRelease(first)).toBe('first contracts')
    await buildContracts('second contracts')
    const second = join(directory, 'releases/second/apps/api')
    await deployProductionApi(run, second, { dependencies })
    expect(deploys).toBe(1)
    expect(await callRelease(second)).toBe('second contracts')
    expect(await callRelease(first)).toBe('first contracts')
    expect(await realpath(join(first, 'node_modules/zod'))).toBe(await realpath(join(second, 'node_modules/zod')))
    await buildContracts('mutable source')
    expect(await callRelease(second)).toBe('second contracts')
    const removed: string[] = []
    await pruneApiDependencies(dependencies.root, [join(directory, 'releases/second')],
      { removeInBackground: (path: string) => removed.push(path) })
    expect(removed).toEqual([])
    expect(await callRelease(second)).toBe('second contracts')
  } finally {
    await removeFixtureDirectory(directory)
  }
}, 180_000)
