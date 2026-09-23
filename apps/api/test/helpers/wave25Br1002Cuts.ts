import { vi } from 'vitest'
import type { GraphFact } from '@graphql/contracts/wave25'
import type { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { OPENCODE_RECONCILIATION_EVENT } from '../../src/modules/harnesses/opencodeReconciliation.js'
import { deferred } from './wave25Agent3.js'
import type { br1002OpenCodeRuntime } from './wave25Br1002OpenCodeRuntime.js'

export type Br1002Runtime = Awaited<ReturnType<typeof br1002OpenCodeRuntime>>
export type Br1002NativeArgs = Parameters<PostgresRunRepository['appendNativeEvent']>

/** Pause OUTSIDE publication transactions, before/after the real coordinator
 * callback. It never supplies a terminal event, owner, receipt or saver result.
 * Any degraded input is an explicitly named adverse-path fault injection. */
export function br1002ContinuationCut(f: Br1002Runtime,
  degrade: (args: Br1002NativeArgs) => Br1002NativeArgs = (args) => args) {
  const before = deferred<Br1002NativeArgs>(), after = deferred<Br1002NativeArgs>()
  const enter = deferred(), finish = deferred()
  const original = f.runs.appendNativeEvent.bind(f.runs)
  let selected = false
  const spy = vi.spyOn(f.runs, 'appendNativeEvent').mockImplementation(async (...args) => {
    if (selected || args[0].type !== OPENCODE_RECONCILIATION_EVENT || !args[4]) return original(...args)
    selected = true
    before.resolve(args)
    await enter.promise
    const actual = degrade(args)
    await original(...actual)
    after.resolve(actual)
    await finish.promise
  })
  return { before, after, enter, finish, original,
    release() { enter.resolve(); finish.resolve() }, restore() { spy.mockRestore() } }
}
export function br1002At<T>(point: Promise<T>, operation: Promise<unknown>): Promise<T> {
  return Promise.race([point, operation.then((result) => {
    const job = result as { state?: string; error?: { code?: string } } | undefined
    throw new Error(`Operation returned before the required native publication cut: ${job?.state ?? 'none'} ${job?.error?.code ?? ''}`)
  })])
}
export async function br1002Ack(f: Br1002Runtime, interactionId: string) {
  return (await f.db.pool.query<{ state: string; approval_native_ack_id: string | null; approval_native_ack_source: unknown }>(
    'select state,approval_native_ack_id,approval_native_ack_source from interaction_graph_resumes where interaction_id=$1',
    [interactionId])).rows[0]
}
export async function br1002Batches(f: Br1002Runtime) {
  return (await f.db.pool.query<{ sequence: string; payload: string }>(
    "select sequence::text,payload from run_graph_batches where run_id=$1 and kind='events' order by sequence",
    [f.f.run.id])).rows.map((row) => ({ sequence: row.sequence,
    facts: (JSON.parse(row.payload) as { events: { fact: GraphFact }[] }).events.map((event) => event.fact) }))
}
