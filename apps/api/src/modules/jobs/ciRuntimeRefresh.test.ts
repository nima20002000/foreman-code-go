import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreparedCiRuntime } from '@foreman-code/contracts'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { InstalledVerificationRuntimeConfigurationSchema } from './installedVerificationConfiguration.js'
import { nextCaptureInput, recaptureCiTools, retireCiRuntimeConfigurations, scheduleCiRuntimeRefresh } from './ciRuntimeRefresh.js'

const commands = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[]) => ({
      stdout: await commands.run(file, args), stderr: '',
    }),
  })
  return { ...actual, execFile }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: (path: string, ...options: unknown[]) => path === '/proc/self/cgroup'
    ? Promise.resolve('0::/user.slice/worker.service\n')
    : actual.readFile(path, ...(options as [])) }
})

const roots: string[] = []
afterEach(async () => {
  commands.run.mockReset()
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})

function fixture() {
  const f = verificationRuntimeFixture()
  const fingerprint = f.measurement.fingerprint
  const omitted = new Set(['schemaVersion', 'profileId', 'profileRevision', 'specDigest', 'root', 'hostRef',
    'registration', 'mainInstallationId'])
  const machine = Object.fromEntries(Object.entries(fingerprint).filter(([key]) => !omitted.has(key)))
  const manifest = { version: 1, ...fingerprint.root.source, git: { commit: fingerprint.sourceCommit,
    tree: 'a'.repeat(40), objectFormat: 'sha1' }, capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved',
    entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  const tools = [
    { kind: 'postgresql', executable: '/usr/lib/postgresql/17/bin/postgres', version: '17.1', binarySha256: '1'.repeat(64) },
    { kind: 'browser', executable: '/usr/bin/chromium', version: 'Chromium 1', binarySha256: '2'.repeat(64) },
    { kind: 'claude', executable: '/usr/bin/claude', version: '1.0', binarySha256: '3'.repeat(64) },
    ...fingerprint.tools,
  ]
  const current = InstalledVerificationRuntimeConfigurationSchema.parse({ schemaVersion: 2, root: fingerprint.root,
    machine: { ...machine, tools }, seedReceiptPath: '/ci/seed-receipt.json',
    seedReceiptSha256: fingerprint.seedReceiptSha256, qualificationSource: { directory: '/ci/source', manifest },
    descriptor: { target: { hostRef: fingerprint.hostRef, registration: fingerprint.registration,
      mainInstallationId: fingerprint.mainInstallationId }, runtimeExecutable: fingerprint.runtimeExecutable,
      ociExecutable: fingerprint.ociExecutable, findmntExecutable: '/usr/bin/findmnt', findmntBinarySha256: 'f'.repeat(64),
      runtimeRoot: '/ci/runtime', backingFile: null, volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes,
      controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
      quota: fingerprint.quota, quotaPool: fingerprint.quotaPool, resources: fingerprint.resources,
      network: fingerprint.network, approvalConfig: fingerprint.approvalConfig,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
      runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
      aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest } })
  const prepared: PreparedCiRuntime = { commit: fingerprint.sourceCommit!, imageId: `sha256:${'9'.repeat(64)}`,
    imageManifestDigest: `sha256:${'8'.repeat(64)}`, seedReceiptPath: '/ci/prepared-seed.json',
    contextReceiptPath: '/ci/context.json', qualificationSource: '/ci/prepared-source',
    unitCodex: { executable: '/opt/graphql-ci/tools/codex', sourceExecutable: '/ci/prepared-codex',
      version: 'new-codex', binarySha256: '7'.repeat(64) } }
  return { current, prepared }
}

describe('CI runtime refresh', () => {
  it('captures a project runtime without claiming a Codex binary that it does not contain', async () => {
    const f = fixture()
    delete f.prepared.unitCodex
    const directory = await privateFixtureDirectory('ci-project-tools-')
    roots.push(directory)
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'image tool')
      if (args.includes('run')) return 'postgres (PostgreSQL) 17.2'
      return ''
    })
    const tools = await recaptureCiTools(f.current.machine.tools, f.prepared, directory, process.env)
    expect(tools.some(tool => tool.kind === 'codex')).toBe(false)
    const next = nextCaptureInput(f.current, f.prepared, { root: f.current.root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources })
    expect(next.toolSources.some(tool => tool.kind === 'codex')).toBe(false)
  })

  it('captures PostgreSQL from the image when the previous unit-only runtime had no database identity', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-integration-tools-')
    roots.push(directory)
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'postgres-image-binary')
      if (args.includes('run')) return 'postgres (PostgreSQL) 17.6'
      return ''
    })
    const sources = await recaptureCiTools(f.current.machine.tools.filter(tool => tool.kind === 'codex'),
      f.prepared, directory, process.env)
    const database = sources.find(tool => tool.kind === 'postgresql')
    expect(database).toMatchObject({ executable: '/usr/lib/postgresql/17/bin/postgres', version: '17.6' })
    expect(await readFile(database!.sourceExecutable, 'utf8')).toBe('postgres-image-binary')
    const next = nextCaptureInput(f.current, f.prepared, { root: f.current.root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources, toolSources: sources })
    expect(next.toolSources).toContainEqual(database)
  })

  it('retains the identities needed by integration, browser and native suites in the capture input', () => {
    const f = fixture()
    const next = nextCaptureInput(f.current, f.prepared, { root: f.current.root,
      manifest: f.current.qualificationSource.manifest, seedReceiptPath: f.prepared.seedReceiptPath,
      resources: f.current.machine.resources })
    expect(next.toolSources.map(tool => tool.kind).sort()).toEqual(['browser', 'claude', 'codex', 'postgresql'])
    expect(next.toolSources.find(tool => tool.kind === 'codex')).toMatchObject({ version: 'new-codex',
      sourceExecutable: '/ci/prepared-codex' })
  })

  it('recaptures each non-Codex tool from the prepared image rather than carrying old binary identities', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-tools-')
    roots.push(directory)
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, `new:${args.at(-2)}`)
      if (args.includes('run')) return args.some(arg => arg.includes('postgres')) ? 'postgres (PostgreSQL) 17.2' : 'new-version'
      return ''
    })
    const sources = await recaptureCiTools(f.current.machine.tools, f.prepared, directory, process.env)
    expect(sources.map(tool => tool.kind).sort()).toEqual(['browser', 'claude', 'codex', 'postgresql'])
    expect(sources.find(tool => tool.kind === 'postgresql')?.version).toBe('17.2')
    for (const tool of sources.filter(value => value.kind !== 'codex')) {
      const bytes = await readFile(tool.sourceExecutable)
      expect(bytes.toString()).toBe(`new:container:${tool.executable}`)
      expect(createHash('sha256').update(bytes).digest('hex'))
        .not.toBe(f.current.machine.tools.find(value => value.kind === tool.kind)!.binarySha256)
    }
  })

  it('retires previous configurations whose image nothing still uses and keeps the current one', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-retention-')
    roots.push(directory)
    const used = `sha256:${'c'.repeat(64)}`, unused = `sha256:${'d'.repeat(64)}`
    const previous = (image: string, source: string) => JSON.stringify({ ...f.current,
      machine: { ...f.current.machine, imageDigest: image },
      qualificationSource: { ...f.current.qualificationSource, directory: source } })
    await writeFile(join(directory, 'job-runtime.json'), JSON.stringify(f.current))
    await writeFile(join(directory, `job-runtime-${'b'.repeat(64)}.json`), previous(used, '/ci/installer/qualification-source-used'))
    await writeFile(join(directory, `job-runtime-${'e'.repeat(64)}.json`), previous(unused, '/ci/installer/qualification-source-old'))
    const retained = await retireCiRuntimeConfigurations(directory, [used])
    expect(retained.images.sort()).toEqual([f.current.machine.imageDigest, used].sort())
    expect(retained.paths.sort()).toEqual([f.current.qualificationSource.directory,
      '/ci/installer/qualification-source-used'].sort())
    expect((await readdir(directory)).sort()).toEqual(['job-runtime.json', `job-runtime-${'b'.repeat(64)}.json`].sort())
  })

  it('schedules the Worker stop only after both its active Job and Agent session finish', async () => {
    const f = fixture()
    const directory = await privateFixtureDirectory('ci-refresh-')
    roots.push(directory)
    const stateDirectory = join(directory, 'state')
    await mkdir(stateDirectory)
    await writeFile(join(stateDirectory, 'job-runtime.json'), JSON.stringify(f.current), { mode: 0o600 })
    const seedReceiptPath = join(directory, 'prepared-seed.json')
    await writeFile(seedReceiptPath, '{}')
    let finishJob!: () => void
    let finishAgent!: () => void
    let beganDrain!: () => void
    const draining = new Promise<void>(resolve => { beganDrain = resolve })
    const job = new Promise<void>(resolve => { finishJob = resolve })
    const agent = new Promise<void>(resolve => { finishAgent = resolve })
    commands.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) await writeFile(args.at(-1)!, 'new-binary')
      return 'new-version'
    })
    const refreshing = scheduleCiRuntimeRefresh({ operationId: randomUUID(), stateDirectory,
      prepared: { ...f.prepared, seedReceiptPath },
      root: f.current.root, manifest: f.current.qualificationSource.manifest, resources: f.current.machine.resources,
      drain: async () => { beganDrain(); await Promise.all([job, agent]) } })
    try {
      const first = await Promise.race([draining.then(() => 'draining'), refreshing.then(() => 'scheduled')])
      expect(first).toBe('draining')
      expect(commands.run.mock.calls.some(([file]) => file === 'systemd-run')).toBe(false)
      finishJob()
      await Promise.resolve()
      expect(commands.run.mock.calls.some(([file]) => file === 'systemd-run')).toBe(false)
      finishAgent()
      expect(await refreshing).toMatchObject({ workerUnit: 'worker.service' })
      expect(commands.run.mock.calls.some(([file]) => file === 'systemd-run')).toBe(true)
    } finally { finishJob(); finishAgent(); await refreshing }
  })
})
