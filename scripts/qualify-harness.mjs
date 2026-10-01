#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { harness: { type: 'string' }, binary: { type: 'string' },
  model: { type: 'string' } } })
if (!['codex', 'opencode'].includes(values.harness) || !values.binary) {
  throw new Error('Usage: qualify-harness --harness codex|opencode --binary /path/to/binary [--model provider/model]')
}
const resolveBinary = async (binary) => {
  const candidates = isAbsolute(binary) || binary.includes('/') ? [resolve(binary)]
    : (process.env.PATH ?? '').split(delimiter).map((part) => join(part, binary))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return realpath(candidate) } catch { /* Next PATH entry. */ }
  }
  throw new Error('Installed harness binary was not found.')
}
const binary = await resolveBinary(values.binary)
if (!(await stat(binary)).isFile()) throw new Error('Harness binary must be a regular file.')
const sha256 = async () => createHash('sha256').update(await readFile(binary)).digest('hex')
const before = await sha256()
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { tsImport } = await import(requireApi.resolve('tsx/esm/api'))
const source = (name) => new URL(`../apps/api/src/modules/harnesses/qualification/${name}`, import.meta.url).href
const { QUALIFICATION_TARGET_PROFILE, runAsQualificationCandidate, codexQualificationSuite, opencodeQualificationSuite,
  withNativeQualificationOwnership, NativeProcessRegistry, runCommand, inheritedAgentEnvironment,
  discoverLauncher, passiveDriverPayloads } = await tsImport(source('cliEntry.ts'), import.meta.url)
const workRoot = await mkdtemp(join(tmpdir(), `graphql-${values.harness}-qualification-`))
const workDirectory = join(workRoot, 'project')
await mkdir(workDirectory)
const registry = new NativeProcessRegistry(join(workRoot, 'native-process-registry'))
const cleanups = new Set()
const ownCleanup = (close) => { cleanups.add(close); return () => cleanups.delete(close) }
const environment = { generation: randomUUID(), provenance: 'terminal', cwd: workDirectory, path: process.env.PATH ?? '' }
let installation
const guard = async (signal) => {
  if (!installation) throw new Error('Native installation evidence is unavailable.')
  const current = await discoverLauncher(binary, environment,
    (installation.payloadFingerprints ?? []).filter((entry) => entry.path !== binary).map((entry) => entry.path), signal)
  if (!installation.fingerprint || current.fingerprint !== installation.fingerprint) throw new Error('Selected native payload changed during qualification.')
}
const rawSuite = values.harness === 'codex' ? codexQualificationSuite : opencodeQualificationSuite
const suite = withNativeQualificationOwnership(rawSuite, registry, () => guard)
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error('Harness qualification exceeded four minutes.')), 240_000)
const stop = () => controller.abort(new Error('Harness qualification was stopped.'))
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  const payload = await passiveDriverPayloads(values.harness, binary)
  if (!payload.complete) throw new Error('The selected launcher payload cannot be qualified without exact installation evidence.')
  installation = await discoverLauncher(binary, environment, payload.paths, controller.signal)
  if (installation.interpreter) installation = await discoverLauncher(binary, environment,
    [...payload.paths, installation.interpreter], controller.signal)
  if (installation.payloadFingerprints?.find((entry) => entry.path === binary)?.fingerprint !== before) {
    throw new Error('Selected native launcher changed before qualification admission.')
  }
  await guard(controller.signal)
  const versionScope = registry.reserveLaunch(`qualification-version:${values.harness}:${randomUUID()}`)
  const closeVersion = async () => {
    await registry.abandonReservedLaunch(versionScope)
    if (!await registry.closeOwner(versionScope.owner)) throw new Error('Native version probe closure is unconfirmed.')
  }
  const releaseVersion = ownCleanup(closeVersion)
  const versionResult = await runCommand(binary, ['--version'], workDirectory, controller.signal, inheritedAgentEnvironment(), { recovery: versionScope })
  await closeVersion(); releaseVersion()
  if (versionResult.exitCode !== 0) throw new Error('Harness version probe failed.')
  const reported = (versionResult.stdout || versionResult.stderr).trim()
  const version = values.harness === 'codex' ? reported.replace(/^codex-cli\s+/, '') : reported
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Harness did not report a release version.')
  const result = await runAsQualificationCandidate(values.harness, before, () => suite.run({ binary, version, binarySha256: before,
    profile: QUALIFICATION_TARGET_PROFILE[values.harness], model: values.model ?? null,
    workDirectory, signal: controller.signal, ownCleanup }))
  const unchanged = before === await sha256()
  const checks = [...result.checks, { id: 'binary-unchanged', passed: unchanged,
    detail: unchanged ? null : 'Installed binary changed during qualification.' }]
  process.stdout.write(JSON.stringify({ harness: values.harness, version, binarySha256: before,
    profile: QUALIFICATION_TARGET_PROFILE[values.harness], suiteRevision: suite.revision,
    checks, evidence: result.evidence }) + '\n')
  if (checks.some((check) => !check.passed)) process.exitCode = 1
} finally {
  clearTimeout(timeout)
  controller.abort(new Error('Qualification cleanup'))
  const results = await Promise.allSettled([...cleanups].map(async (close) => { await close(); cleanups.delete(close) }))
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Qualification cleanup remains uncertain; recovery records were retained.')
  await rm(workRoot, { recursive: true, force: true })
}
