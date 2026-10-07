import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, readFile, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { InstalledVerificationRuntimeCaptureInputSchema, InstalledVerificationRuntimeConfigurationSchema,
  type InstalledVerificationRuntimeCaptureInput } from './installedVerificationConfiguration.js'
import type { JobResourceRequest, PreparedCiRuntime } from '@foreman-code/contracts'

const run = promisify(execFile)

/** The next protected runtime: the current installation with the prepared image, seed, qualification source and root. */
export function nextCaptureInput(current: unknown, prepared: PreparedCiRuntime, input: {
  root: SourceRootRecord; manifest: SourceManifest; seedReceiptPath: string; resources: JobResourceRequest
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
    toolSources: [{ kind: 'codex', executable: prepared.unitCodex.executable,
      sourceExecutable: prepared.unitCodex.sourceExecutable, version: prepared.unitCodex.version }],
  })
}

/** Writes the reviewed refresh input and restarts this Worker around `refresh-job-runtime`, which needs the
 * Worker stopped. Runs as a separate user unit so it survives the Worker's own stop. */
export async function scheduleCiRuntimeRefresh(input: {
  stateDirectory: string; prepared: PreparedCiRuntime; root: SourceRootRecord; manifest: SourceManifest
  resources: JobResourceRequest; environment?: NodeJS.ProcessEnv
}): Promise<{ unit: string; workerUnit: string }> {
  const environment = input.environment ?? process.env
  const configurationPath = join(input.stateDirectory, 'job-runtime.json')
  const currentBytes = await readFile(configurationPath)
  const base = dirname(input.stateDirectory)
  const short = input.prepared.commit.slice(0, 12)
  const seedReceiptPath = join(base, `installed-seed-receipt-${short}.json`)
  await copyFile(input.prepared.seedReceiptPath, seedReceiptPath)
  await chmod(seedReceiptPath, 0o600)
  const captureInput = nextCaptureInput(JSON.parse(currentBytes.toString('utf8')), input.prepared,
    { root: input.root, manifest: input.manifest, seedReceiptPath, resources: input.resources })
  const refreshPath = join(base, `reviewed-refresh-${short}.json`)
  await writeFile(refreshPath, JSON.stringify({ expectedConfigurationSha256: createHash('sha256').update(currentBytes).digest('hex'),
    captureInput }), { mode: 0o600 })
  const workerUnit = await currentServiceUnit()
  const unit = `foreman-ci-refresh-${short}`
  const log = join(base, `refresh-${short}.log`)
  await writeFile(join(base, LAST_REFRESH), JSON.stringify({ commit: input.prepared.commit, log }), { mode: 0o600 })
  const script = `systemctl --user stop "$1"; "$2" "$3" refresh-job-runtime --state "$4" --input "$5" > "$6" 2>&1;`
    + ` echo "exit=$?" >> "$6"; systemctl --user start "$1"`
  await run('systemd-run', ['--user', '--collect', `--unit=${unit}`, `--setenv=PATH=${environment.PATH ?? '/usr/bin:/bin'}`,
    '/bin/sh', '-c', script, 'refresh', workerUnit, process.execPath, process.argv[1]!, input.stateDirectory, refreshPath, log],
  { env: environment })
  return { unit, workerUnit }
}

const LAST_REFRESH = 'ci-runtime-last-refresh.json'
/** The outcome of the last refresh, read by the restarted Worker: null while none ran. */
export async function lastCiRuntimeRefresh(stateDirectory: string): Promise<{ commit: string; ok: boolean; log: string } | null> {
  const recorded = await readFile(join(dirname(stateDirectory), LAST_REFRESH), 'utf8').catch(() => null)
  if (!recorded) return null
  const { commit, log } = JSON.parse(recorded) as { commit: string; log: string }
  const text = await readFile(log, 'utf8').catch(() => '')
  return { commit, ok: /^exit=0$/mu.test(text), log: text.slice(-1500) }
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
