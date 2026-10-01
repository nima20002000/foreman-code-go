import { describe, expect, it } from 'vitest'
import { currentGraphPrincipal, currentGraphReadUnit } from './helpers/currentGraphReadUnit.js'

// Current V3 canonical read, not the removed V1 liveSnapshot SQL. The actual
// primary transaction, immutable readers, projection and permanent-receipt
// verification run on a strict SQL-shaped model. This is not a scale benchmark.
describe('FE-R2-001 current canonical read (SQL model, not a database scale test)', () => {
  it('uses one coherent read transaction and never loads historical bodies or unbounded activity', async () => {
    const f = await currentGraphReadUnit()
    const value = await f.canonical.current(f.principal, f.request)
    expect(value.kind).toBe('current')
    expect(value.scope).toEqual(f.request.scope)
    expect(f.db.calls[0]).toBe('begin isolation level repeatable read read only')
    expect(f.db.calls.at(-1)).toBe('commit')
    expect(f.db.calls.filter((q) => q.startsWith('begin '))).toHaveLength(1)
    expect(f.db.calls.some((q) => /insert |update |from run_activity|harness_native_events|input_json|result_json|\boffset\b/i.test(q))).toBe(false)
    expect(f.db.calls.some((q) => q.startsWith('select p.record,p.source_digest,p.semantic_digest,p.sequence::text,'))).toBe(true)
    expect(f.db.calls.some((q) => q.includes('left join run_graph_sources s') && q.includes('s.source_revision=p.sequence'))).toBe(true)
    expect(value).not.toHaveProperty('activity'); expect(value).not.toHaveProperty('liveActivity')
    const latest = f.db.calls.find((q) => q.startsWith('select distinct on (e.workflow_node_id) e.id'))!
    expect(latest).toContain('order by e.workflow_node_id,w.activation_sequence desc nulls last, coalesce(o.occurrence_index,0) desc,x.technical_attempt desc,x.execution_id desc limit 1001')
    expect(latest).not.toContain("e.record->'input'")
    expect(latest).not.toContain("e.record->'result' as")
    expect(value.state.executions).toEqual([]); expect(value.state.occurrences).toEqual([])
  })
  it('has fixed current DTO/query work at positions 10 versus 100000 (model rows only)', async () => {
    const responses = [], queries = []
    for (const head of [10, 100000]) {
      const f = await currentGraphReadUnit()
      // Scalar position only: the model supplies the same committed current cut,
      // not an in-memory list of fabricated historical execution rounds.
      f.db.state.head = head
      responses.push(await f.canonical.current(f.principal, f.request)); queries.push([...f.db.calls])
    }
    expect(queries[0]).toEqual(queries[1])
    expect({ ...responses[0], asOfSequence: 'same' }).toEqual({ ...responses[1], asOfSequence: 'same' })
    expect(JSON.stringify(responses[1]).length - JSON.stringify(responses[0]).length).toBe(4)
  })
  it.each([false, true])('keeps completed outcome separate from cleanup=%s without inferring physical closure', async (cleanupPending) => {
    const f = await currentGraphReadUnit()
    await f.db.changeRun({ executionState: 'completed', outcome: 'succeeded', cleanupPending })
    const result = await f.canonical.current(f.principal, f.request)
    expect(result.state.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded', cleanupPending })
    expect(result.state.run).not.toHaveProperty('processStopped')
    expect(result.state.run).not.toHaveProperty('nativeAcknowledged')
  })
  it('rejects retired, missing, string and unknown request semantics before SQL rather than normalizing', async () => {
    const f = await currentGraphReadUnit()
    for (const executionSemanticsVersion of [1, 2, 4, '3', null, undefined]) {
      await expect(Promise.resolve().then(() => f.canonical.current(f.principal,
        { ...f.request, scope: { ...f.request.scope, executionSemanticsVersion } })))
        .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    }
    expect(f.db.calls).toEqual([])
  })
  it('rejects conflicting physical, version and definition semantics without substituting another reader', async () => {
    for (const layer of ['physical', 'version', 'definition'] as const) {
      const f = await currentGraphReadUnit()
      if (layer === 'physical') f.db.scope.executionSemanticsVersion = 2
      else if (layer === 'version') Object.assign(f.db.fixture.version, { executionSemanticsVersion: 2 })
      else Object.assign(f.db.fixture.version.definition, { executionSemanticsVersion: 2 })
      await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({
        code: layer === 'physical' ? 'GRAPH_SCOPE_MISMATCH' : 'GRAPH_INVARIANT_VIOLATION',
      })
      expect(f.db.calls).toContain('rollback')
      expect(f.db.calls.some((q) => /run_activity|input_json|result_json/.test(q))).toBe(false)
    }
  })
  it('rejects inconsistent persisted identity, definition, duplicate nodes and changed configuration pins', async () => {
    const changes: Array<(f: Awaited<ReturnType<typeof currentGraphReadUnit>>) => void> = [
      (f) => { f.db.fixture.version.id = 'wrong-version' },
      (f) => { f.db.fixture.version.definition.id = 'wrong-workflow' },
      (f) => { f.db.fixture.run.workspaceId = 'wrong-workspace' },
      (f) => { f.db.fixture.version.definition.nodes.push({ ...f.db.fixture.version.definition.nodes[0]! }) },
      (f) => { f.db.fixture.configurations[0]!.agentId = 'wrong-agent' },
      (f) => { f.db.fixture.version.contentHash = `sha256:${'f'.repeat(64)}` },
    ]
    for (const change of changes) {
      const f = await currentGraphReadUnit(); change(f)
      await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
      expect(f.db.calls).toContain('rollback')
      expect(f.db.calls.some((q) => q.startsWith('update ') || q.startsWith('insert '))).toBe(false)
    }
  })
  it('authorizes before protected metadata reads using runs:read without location privilege', async () => {
    const f = await currentGraphReadUnit()
    await expect(f.canonical.current(currentGraphPrincipal(false), f.request)).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    expect(f.db.calls).toEqual([])
    const foreign = currentGraphPrincipal()
    foreign.grants[0]!.scope.workflowIds = ['foreign']
    await expect(f.canonical.current(foreign, f.request)).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    expect(f.db.calls.filter((q) => q.startsWith('select '))).toEqual(['select workspace_id,workflow_id,id from runs where id=$1'])
    const result = await f.canonical.current(f.principal, f.request)
    const wire = JSON.stringify(result)
    expect(wire).not.toMatch(/PRIVATE-RUN-INPUT|executionLocation|authorizationPrincipalId|workingDirectory|runtimeDirectory|nativeSessionId|"prompt"/)
  })
  it('does not fall back to full details on missing head or an exact scope miss', async () => {
    const f = await currentGraphReadUnit(); f.db.initialized = false
    await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({ code: 'GRAPH_NOT_INITIALIZED' })
    expect(f.db.calls.some((q) => /run_activity|harness_native_events|insert |update /.test(q))).toBe(false)
    f.db.initialized = true; f.db.calls.length = 0
    await expect(f.canonical.current(f.principal, { ...f.request, scope: { ...f.request.scope, workflowVersionId: 'foreign-version' } }))
      .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    expect(f.db.calls.some((q) => q.includes('version_record') || q.includes('run_activity'))).toBe(false)
  })
})
