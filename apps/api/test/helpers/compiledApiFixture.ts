import { execFile } from 'node:child_process'
import { cp, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export async function compileApiFixture(directory: string): Promise<string> {
  const repository = fileURLToPath(new URL('../../../../', import.meta.url))
  const api = join(repository, 'apps/api')
  const fixture = join(directory, 'compiled-api')
  const output = join(fixture, 'dist')
  await mkdir(fixture, { recursive: true })
  await cp(join(api, 'package.json'), join(fixture, 'package.json'))
  await symlink(join(api, 'node_modules'), join(fixture, 'node_modules'), 'dir')
  // Runtime fixtures consume JavaScript; source types are validated by the repository typecheck.
  await promisify(execFile)('corepack', [
    'pnpm', '--filter', '@foreman-code/api', 'exec', 'tsc',
    '-p', 'tsconfig.build.json', '--noCheck', '--declaration', 'false', '--outDir', output,
  ], { cwd: repository, env: process.env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  return output
}
