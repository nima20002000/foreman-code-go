import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { InstalledVerificationRuntimeCaptureInputSchema, InstalledVerificationRuntimeConfigurationSchema,
  type InstalledVerificationRuntimeCaptureInput, type InstalledVerificationRuntimeConfiguration }
  from './installedVerificationConfiguration.js'
import type { JobResourceRequest, PreparedCiRuntime } from '@foreman-code/contracts'
import { InstalledJobRuntimeConfigurationRecordSchema } from './installedRuntimeHost.js'

const run = promisify(execFile)

/** The next protected runtime: the current installation with the prepared image, seed, qualification source and root. */
export function nextCaptureInput(current: unknown, prepared: PreparedCiRuntime, input: {
  root: SourceRootRecord; manifest: SourceManifest; seedReceiptPath: string; resources: JobResourceRequest
  toolSources?: InstalledVerificationRuntimeCaptureInput['toolSources']
}): InstalledVerificationRuntimeCaptureInput {
  const configuration = InstalledVerificationRuntimeConfigurationSchema.parse(current)
  const { bootId: _boot, runtimeBinarySha256: _runtime, ociBinarySha256: _oci, configurationDigest: _configuration,
    seedReceiptSha256: _seed, tools: _tools, ...machine } = configuration.machine
  void _boot; void _runtime; void _oci; void _configuration; void _seed; void _tools
  return InstalledVerificationRuntimeCaptureInputSchema.parse({
    schemaVersion: 2, root: input.root, descriptor: { ...configuration.descriptor, resources: input.resources },
    machine: { ...machine, resources: input.resources, limits: input.resources.limits,
      imageDigest: prepared.imageId, imageConfigDigest: prepared.imageId,
      imageManifestDigest: prepared.imageManifestDigest, sourceCommit: prepared.commit },
    seedReceiptPath: input.seedReceiptPath,
    qualificationSource: { directory: prepared.qualificationSource, manifest: input.manifest },
    toolSources: input.toolSources ?? [
      ...configuration.machine.tools.filter(tool => tool.kind !== 'codex').map(tool => ({
        kind: tool.kind, executable: tool.executable, sourceExecutable: tool.executable, version: tool.version,
      })),
      ...preparedCodexSource(prepared),
    ],
  })
}

/** Writes the reviewed refresh input and restarts this Worker around `refresh-job-runtime`, which needs the
 * Worker stopped. Runs as a separate user unit so it survives the Worker's own stop. */
export async function scheduleCiRuntimeRefresh(input: {
  operationId: string
  stateDirectory: string; prepared: PreparedCiRuntime; root: SourceRootRecord; manifest: SourceManifest
  resources: JobResourceRequest; environment?: NodeJS.ProcessEnv
  drain(): Promise<void>
}): Promise<{ unit: string; workerUnit: string }> {
  await input.drain()
  const environment = input.environment ?? process.env
  const configurationPath = join(input.stateDirectory, 'job-runtime.json')
  const currentBytes = await readFile(configurationPath)
  const base = dirname(input.stateDirectory)
  const short = input.operationId
  const seedReceiptPath = join(base, `installed-seed-receipt-${short}.json`)
  await copyFile(input.prepared.seedReceiptPath, seedReceiptPath)
  await chmod(seedReceiptPath, 0o600)
  const configuration = InstalledVerificationRuntimeConfigurationSchema.parse(JSON.parse(currentBytes.toString('utf8')))
  const toolSources = await recaptureCiTools(configuration.machine.tools, input.prepared, base, environment)
  const captureInput = nextCaptureInput(configuration, input.prepared,
    { root: input.root, manifest: input.manifest, seedReceiptPath, resources: input.resources, toolSources })
  const refreshPath = join(base, `reviewed-refresh-${short}.json`)
  await writeFile(refreshPath, JSON.stringify({ expectedConfigurationSha256: createHash('sha256').update(currentBytes).digest('hex'),
    captureInput }), { mode: 0o600 })
  const workerUnit = await currentServiceUnit()
  const unit = `foreman-ci-refresh-${short}`
  const log = join(base, `refresh-${short}.log`)
  await writeFile(join(base, LAST_REFRESH), JSON.stringify({ operationId: input.operationId,
    commit: input.prepared.commit, log }), { mode: 0o600 })
  const script = `systemctl --user stop "$1"; "$2" "$3" refresh-job-runtime --state "$4" --input "$5" > "$6" 2>&1;`
    + ` echo "exit=$?" >> "$6"; systemctl --user start "$1"`
  await run('systemd-run', ['--user', '--collect', `--unit=${unit}`, `--setenv=PATH=${environment.PATH ?? '/usr/bin:/bin'}`,
    '/bin/sh', '-c', script, 'refresh', workerUnit, process.execPath, process.argv[1]!, input.stateDirectory, refreshPath, log],
  { env: environment })
  return { unit, workerUnit }
}

const LAST_REFRESH = 'ci-runtime-last-refresh.json'
/** The outcome of the last refresh, read by the restarted Worker: null while none ran. */
export async function lastCiRuntimeRefresh(stateDirectory: string): Promise<{
  operationId: string | null; commit: string; ok: boolean; log: string
} | null> {
  const recorded = await readFile(join(dirname(stateDirectory), LAST_REFRESH), 'utf8').catch(() => null)
  if (!recorded) return null
  const { operationId, commit, log } = JSON.parse(recorded) as { operationId?: string; commit: string; log: string }
  const text = await readFile(log, 'utf8').catch(() => '')
  return { operationId: operationId ?? null, commit, ok: /^exit=0$/mu.test(text), log: text.slice(-1500) }
}

/** The Worker's own systemd user unit: the innermost `.service` in its cgroup path. */
async function currentServiceUnit(): Promise<string> {
  const cgroup = await readFile('/proc/self/cgroup', 'utf8')
  const unit = cgroup.split('\n').flatMap(line => line.split(':').at(-1)?.split('/') ?? [])
    .filter(part => part.endsWith('.service') && !part.startsWith('user@')).at(-1)
  if (!unit) throw new Error('This Worker is not running as a systemd user service, so it cannot restart itself.')
  return unit
}

/** The installer paths the current protected runtime uses; preparation keeps them. */
export async function currentCiRuntimePaths(stateDirectory: string): Promise<string[]> {
  const text = await readFile(join(stateDirectory, 'job-runtime.json'), 'utf8').catch(() => null)
  if (!text) return []
  const configuration = JSON.parse(text) as { qualificationSource?: { directory?: unknown } }
  return typeof configuration.qualificationSource?.directory === 'string' ? [configuration.qualificationSource.directory] : []
}

/** Protected previous configurations remain recovery inputs after a refresh while something still uses their
 * image: a current verification profile (`keepImages` from Main), an accepted Job or a pending qualification.
 * Others are retired so their image and qualification source can be reclaimed; the current one always stays. */
export async function retireCiRuntimeConfigurations(stateDirectory: string, keepImages: readonly string[]) {
  const kept = new Set(keepImages)
  const retained = { images: [] as string[], paths: [] as string[] }
  for (const name of (await readdir(stateDirectory)).sort()) {
    if (!/^job-runtime(?:-[a-f0-9]{64})?\.json$/u.test(name)) continue
    const raw = JSON.parse(await readFile(join(stateDirectory, name), 'utf8')) as { qualificationSource?: { directory?: unknown } }
    const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(raw)
    const image = configuration.schemaVersion === 2 ? configuration.machine.imageDigest : configuration.pins.imageDigest
    if (name !== 'job-runtime.json' && !kept.has(image)) {
      await rm(join(stateDirectory, name))
      continue
    }
    retained.images.push(image)
    if (typeof raw.qualificationSource?.directory === 'string') retained.paths.push(raw.qualificationSource.directory)
  }
  return retained
}

export async function recaptureCiTools(
  tools: InstalledVerificationRuntimeConfiguration['machine']['tools'],
  prepared: PreparedCiRuntime, directory: string, environment: NodeJS.ProcessEnv,
): Promise<InstalledVerificationRuntimeCaptureInput['toolSources']> {
  const sources = preparedCodexSource(prepared)
  const imageTools = tools.filter(tool => tool.kind !== 'codex').map(({ kind, executable }) => ({ kind, executable }))
  if (!imageTools.some(tool => tool.kind === 'postgresql')) {
    imageTools.push({ kind: 'postgresql', executable: '/usr/lib/postgresql/17/bin/postgres' })
  }
  const container = (await run('podman', ['--remote=false', 'create', prepared.imageId, 'true'],
    { env: environment })).stdout.trim()
  try {
    for (const tool of imageTools) {
      const sourceExecutable = join(directory, `ci-tool-${tool.kind}-${prepared.commit.slice(0, 12)}`)
      await run('podman', ['--remote=false', 'cp', `${container}:${tool.executable}`, sourceExecutable], { env: environment })
      await chmod(sourceExecutable, 0o700)
      const result = await run('podman', ['--remote=false', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
        '--cap-drop=all', '--security-opt=no-new-privileges', '--cpus=1', '--memory=512m', '--pids-limit=64',
        `--entrypoint=${tool.executable}`, prepared.imageId, '--version'], { env: environment })
      let version = result.stdout.trim()
      if (tool.kind === 'postgresql') version = /PostgreSQL\)\s+(\S+)/u.exec(version)?.[1] ?? version
      sources.push({ kind: tool.kind, executable: tool.executable, sourceExecutable, version })
    }
  } finally {
    await run('podman', ['--remote=false', 'rm', container], { env: environment })
  }
  return sources
}

function preparedCodexSource(prepared: PreparedCiRuntime): InstalledVerificationRuntimeCaptureInput['toolSources'] {
  if (!prepared.unitCodex) return []
  return [{ kind: 'codex', executable: prepared.unitCodex.executable,
    sourceExecutable: prepared.unitCodex.sourceExecutable, version: prepared.unitCodex.version }]
}
