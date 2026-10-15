import { CiGetOutputSchema, CiRunOutputSchema, integrationPartition } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('denies callers without CI grants and asks for a GitHub repository first', async () => {
  const f = await fixture({ repository: false })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const denied = await f.call(reader, 'ci_run', { suite: 'unit', commandId: 'denied' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const other = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['workspace-other'] })
    expect((await f.call(other, 'ci_run', { suite: 'unit', commandId: 'foreign' })).isError).toBe(true)
    const missing = await f.call(f.operator, 'ci_run', { suite: 'unit', commandId: 'no-repository' })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('SOURCE_REPOSITORY_REQUIRED')
    expect((await f.call(f.operator, 'ci_run', { suite: 'unit', commandId: 'split-unit', partitions: 2 })).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
  } finally { await f.close() }
})

it.each([0, 1])('persists a finished integration report through MCP for exit code %s', async exitCode => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', commandId: 'finished-report',
    }))
    await f.ci.dispatch()
    f.finish(started.ticketId, exitCode, 'finished\n', { 'apps/api/test/example.integration.test.ts': 1000 })
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', {
      ticketId: started.ticketId, testStatus: ['passed', 'failed', 'skipped'],
      waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(read.tests).toEqual({ summary: { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false })
    expect(read.run).toMatchObject({ state: exitCode === 0 ? 'passed' : 'failed', collection: 'complete' })
    expect((await f.pool.query<{ test_results: unknown }>('select test_results from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.test_results).toEqual(read.tests)
  } finally { await f.close() }
})

it('learns integration file durations from finished runs and hands every partition of the next run the same ones', async () => {
  const f = await fixture()
  const file = (name: string) => `apps/api/test/${name}.integration.test.ts`
  const startedDurations = () => f.started.map(value => value.request.operation === 'start' ? value.request.durations : 'none')
  try {
    const first = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-1',
      partitions: 2 }))
    await f.ci.dispatch()
    // Nothing learned yet: the build computers use the commit's committed durations.
    expect(startedDurations()).toEqual([undefined, undefined])
    f.finish(first.partitions![0]!.ticketId, 0, 'ok\n', { [file('a')]: 1000, [file('b')]: 2000 })
    f.finish(first.partitions![1]!.ticketId, 1, 'FAIL\n', { [file('c')]: 3000 })
    const completed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: first.ticketId }))
    expect(completed.group!.state).toBe('failed')
    expect(completed.partitions!.every(run => run.collection === 'complete')).toBe(true)
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [completed.run.groupId])).rows.map(row => row.record)).toEqual(expect.arrayContaining(completed.partitions!))
    const learned = { [file('a')]: 1000, [file('b')]: 2000, [file('c')]: 3000 }
    const second = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-2',
      partitions: 2 }))
    await f.ci.dispatch()
    expect(startedDurations().slice(2)).toEqual([learned, learned])
    // A slower measurement moves the expectation halfway.
    f.finish(second.partitions![0]!.ticketId, 0, 'ok\n', { [file('a')]: 3000 })
    f.finish(second.partitions![1]!.ticketId, 0, 'ok\n')
    await f.ci.dispatch()
    expect((await f.pool.query(`select file,duration_ms,samples from ci_file_durations where repository='octo/site'
      order by file`)).rows).toEqual([{ file: file('a'), duration_ms: 2000, samples: 2 },
      { file: file('b'), duration_ms: 2000, samples: 1 }, { file: file('c'), duration_ms: 3000, samples: 1 }])
    CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'integration', commandId: 'learn-3' }))
    CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'unit', commandId: 'learn-unit' }))
    // ci_run starts a dispatch of its own, which may predate the second run.
    await f.ci.dispatch()
    await f.ci.dispatch()
    expect(f.started.slice(4).map(value => value.request.operation === 'start' && value.request.suite)).toEqual(['integration', 'unit'])
    expect(startedDurations().slice(4)).toEqual([{ ...learned, [file('a')]: 2000 }, undefined])
  } finally { await f.close() }
})

it.each(['full', 'affected'] as const)('automatically sizes %s integration via MCP with estimates and persisted readback', async scope => {
  const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/timed-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 120_000]))
  const f = await fixture({ integrationInventory: { files, durations }, cloud: { github: 16, circleci: 28 } })
  f.computers.splice(0, 2)
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const input = { suite: 'integration', scope, commit: 'a'.repeat(40), commandId: `automatic-${scope}`,
      ...(scope === 'affected' ? { files: files.slice(0, 6) } : {}) }
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(started.partitions).toHaveLength(scope === 'full' ? 10 : 3)
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions!.every(run => run.expectedDurationMs === 330_000)).toBe(true)
    expect(read.partitions!.every(run => run.state === 'running')).toBe(true)
    expect(read.partitions!.every(run => run.computer?.hostRef.kind === 'cloud')).toBe(true)
    const selected = scope === 'full' ? files : files.slice(0, 6)
    const slices = read.partitions!.map(run => integrationPartition(selected, durations, run.partition!))
    expect(slices.flat().sort()).toEqual([...selected].sort())
    const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)
    expect(stored).toEqual(expect.arrayContaining(read.partitions!))
    for (const run of read.partitions!) f.finish(run.id, 0, 'passed')
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: started.ticketId })).group?.state)
      .toBe('passed')
  } finally { await f.close() }
})
