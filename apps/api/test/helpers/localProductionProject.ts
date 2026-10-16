import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function createLocalProductionProject(project: string) {
  await mkdir(project)
  await writeFile(join(project, 'package.json'), '{"packageManager":"pnpm@11.27.0"}\n')
  await writeFile(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n')
  await writeFile(join(project, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 2880\n')
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_')))
  const git = (args: string[]) => execute('git', args, { cwd: project, env: environment })
  await git(['init', '-q'])
  await git(['add', '.'])
  await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  const { stdout } = await git(['rev-parse', 'HEAD'])
  return { commit: stdout.trim(), environment }
}
