import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { expect, it } from 'vitest'
import { assertTestDatabase, provisionTestResources, testAdminPool } from '../../../scripts/test-resources.mjs'
import { groupUsed, stopGroup } from '../../../scripts/integration-process.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const registryModule = pathToFileURL(join(root, 'apps/api/src/modules/harnesses/recovery/processRegistry.ts')).href
const resourcesModule = pathToFileURL(join(root, 'scripts/test-resources.mjs')).href
const wrapper = join(root, 'scripts/test-command.mjs')

function exit(child: ChildProcess): Promise<number | null> {
  return once(child, 'exit').then(([code]) => code as number | null)
}

async function waitForFile(file: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(file)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error('Owned test child did not report readiness')
    }
    await delay(50)
  }
}

it('retains the outer database and native registry after failed closure, then recovers them in a fresh process', async () => {
  const environment = { ...process.env }
  delete environment.GRAPHQL_TEST_ROOT
  delete environment.GRAPHQL_TEST_OWNER
  const program = `
    import { join } from 'node:path';
    import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
    import { registerTestResourceCleanup } from ${JSON.stringify(resourcesModule)};
    const resource = { directory: process.env.GRAPHQL_TEST_ROOT, token: process.env.GRAPHQL_TEST_OWNER,
      databaseUrl: process.env.TEST_DATABASE_URL, name: new URL(process.env.TEST_DATABASE_URL).pathname.slice(1) };
    const registryDirectory = join(resource.directory, 'qualification-registry');
    const owner = 'unfinished-native-qualification';
    const registry = new NativeProcessRegistry(registryDirectory);
    const cleanupId = registerTestResourceCleanup(resource, { kind: 'native-qualification', registryDirectory, owner });
    registry.reserveLaunch(owner);
    console.log('RECOVERY_RESOURCE ' + JSON.stringify({ resource, registryDirectory, owner, cleanupId }));
    await registry.closeOwner(owner);
  `
  const child = spawn(process.execPath, [wrapper, '--', process.execPath, '--import', require.resolve('tsx'),
    '--input-type=module', '-e', program], { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.resume()
  let retained: { resource: { directory: string; token: string; databaseUrl: string; name: string };
    registryDirectory: string; owner: string; cleanupId: string } | undefined
  try {
    expect(await exit(child)).not.toBe(0)
    const line = output.split('\n').find(value => value.startsWith('RECOVERY_RESOURCE '))
    if (!line) throw new Error('Native recovery identity was not reported')
    retained = JSON.parse(line.slice('RECOVERY_RESOURCE '.length)) as NonNullable<typeof retained>
    expect(existsSync(retained.registryDirectory)).toBe(true)
    const admin = await testAdminPool()
    try { await assertTestDatabase(admin, retained.resource) }
    finally { await admin.end() }
    const pool = new pg.Pool({ connectionString: retained.resource.databaseUrl, max: 1 })
    try { expect((await pool.query('select 1 as retained')).rows).toEqual([{ retained: 1 }]) }
    finally { await pool.end() }
    const recovery = spawn(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
      import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
      import { completeTestResourceCleanup, cleanupTestResources } from ${JSON.stringify(resourcesModule)};
      const saved = ${JSON.stringify(retained)};
      if (!await new NativeProcessRegistry(saved.registryDirectory).closeOwner(saved.owner)) {
        throw new Error('Native recovery closure remains unconfirmed');
      }
      completeTestResourceCleanup(saved.resource, saved.cleanupId);
      await cleanupTestResources(saved.resource);
    `], { cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    recovery.stdout?.resume()
    recovery.stderr?.resume()
    try { expect(await exit(recovery)).toBe(0) }
    finally { await stopGroup(recovery.pid) }
    expect(existsSync(retained.resource.directory)).toBe(false)
    const check = await testAdminPool()
    try {
      expect((await check.query('select datname from pg_database where datname=$1', [retained.resource.name])).rows).toEqual([])
    } finally { await check.end() }
  } finally {
    await stopGroup(child.pid)
    // Unconfirmed native state stays available if the recovery assertion fails.
  }
}, 60_000)

it.each(['SIGINT', 'SIGTERM'] as const)('escalates %s for an ignoring detached suite group and retains a nonzero result', async signal => {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const ready = join(resources.environment.GRAPHQL_TEST_ROOT!, 'child-ready.json')
  const program = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, ['-e',
      'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pgid: process.pid, descendant: descendant.pid }));
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, [wrapper, '--', process.execPath, '-e', program], {
    cwd: root, env: resources.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const ended = exit(child)
  let pgid: number | undefined
  try {
    await waitForFile(ready, child)
    pgid = (JSON.parse(await readFile(ready, 'utf8')) as { pgid: number }).pgid
    child.kill(signal)
    expect(await ended).toBe(signal === 'SIGINT' ? 130 : 143)
    expect(groupUsed(pgid)).toBe(false)
    await resources.close()
    expect(existsSync(resources.environment.GRAPHQL_TEST_ROOT!)).toBe(false)
  } finally {
    await stopGroup(child.pid)
    await stopGroup(pgid)
  }
}, 30_000)
