import { matchesGlob } from 'node:path'
import { CI_UNIT_SHARD_LIMIT, CI_HEAVY_WEB_SHARDS, integrationPartition, requiresUserSystemd, type CiDurations, type CiPart, type CiPartition,
  type CiRunInput } from '@foreman-code/contracts'

export interface CiUnitInventory {
  files: string[]
  durations: CiDurations
  heavy: string[]
}
interface PlannedPart { part: CiPart | null; partition: CiPartition | null; files: string[] }

/** Aim for 150 seconds of measured test time per unit shard; unknown repositories use the default counts. */
function unitShardCount(part: 'unit-api' | 'unit-web', files: string[], durations: CiDurations, slots: number) {
  const measured = files.map(file => durations[file]).filter((value): value is number => value !== undefined)
  const fallback = part === 'unit-api' ? 5 : 3
  if (!measured.length) return Math.min(fallback, files.length || fallback, Math.max(1, slots))
  const sorted = [...measured].sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const total = files.reduce((sum, file) => sum + (durations[file] ?? median), 0)
  return Math.min(CI_UNIT_SHARD_LIMIT, files.length, Math.max(1, slots), Math.max(1, Math.ceil(total / 150_000)))
}

export function planCiParts(input: CiRunInput, durations: CiDurations, inventory?: CiUnitInventory, slots = CI_UNIT_SHARD_LIMIT): PlannedPart[] {
  const affected = (input.scope ?? 'affected') === 'affected' && input.files !== undefined
  const selected = affected ? [...new Set(input.files)].sort() : []
  if (affected && !selected.length) return [{ part: null, partition: null, files: [] }]
  if (input.suite === 'install' || input.suite === 'integration') {
    const mixed = input.suite === 'integration' && selected.some(requiresUserSystemd)
      && selected.some(file => !requiresUserSystemd(file))
    const requested = Math.max(input.partitions ?? 1, mixed ? 2 : 1)
    const count = affected ? Math.min(requested, selected.length) : requested
    return Array.from({ length: Math.max(1, count) }, (_, index) => ({ part: null,
      partition: count > 1 ? { index, count } : null, files: selected }))
  }
  const names: CiPart[] = input.suite === 'unit'
    ? ['unit-api', 'unit-web', 'unit-web-heavy', 'unit-other']
    : [`${input.suite}-api`, `${input.suite}-other`]
  const belongs = (file: string, part: CiPart) => {
    if (part.endsWith('-api')) return file.startsWith('apps/api/')
    if (part.endsWith('-other')) return !file.startsWith('apps/api/') && (input.suite !== 'unit' || !file.startsWith('apps/web/'))
    const web = file.startsWith('apps/web/')
    const heavy = inventory?.heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern)) ?? false
    return web && (part === 'unit-web-heavy' ? heavy : !heavy)
  }
  return names.flatMap(part => {
    const files = selected.filter(file => belongs(file, part))
    if (affected && !files.length) return []
    const candidates = affected ? files : inventory?.files.filter(file => belongs(file, part)) ?? []
    const sharded = part === 'unit-api' || part === 'unit-web'
    if (!affected && inventory && sharded && !candidates.length) return []
    // The heavy web phase is one long Vitest run; Vitest splits it evenly across a fixed number of machines.
    const count = sharded ? unitShardCount(part, candidates, durations, slots) : part === 'unit-web-heavy' && !affected ? CI_HEAVY_WEB_SHARDS : 1
    return Array.from({ length: count }, (_, index) => {
      const partition = count > 1 ? { index, count } : null
      const slice = affected && partition ? integrationPartition(files, durations, partition) : files
      return { part, partition, files: slice }
    })
  })
}

/** The unit part a test file runs in, as planCiParts splits it. */
export function unitPartOf(file: string, heavy: readonly string[]): CiPart {
  if (file.startsWith('apps/api/')) return 'unit-api'
  if (!file.startsWith('apps/web/')) return 'unit-other'
  return heavy.some(pattern => matchesGlob(file.slice('apps/web/'.length), pattern)) ? 'unit-web-heavy' : 'unit-web'
}

/** CircleCI takes every suite except the Worker unit tests, which need podman. */
export function runsOnCircleCi(run: { part?: string | null | undefined }): boolean {
  return run.part !== 'unit-other'
}

export function ciGroupState(runs: readonly { state: string }[]) {
  for (const state of ['failed', 'lost', 'canceled', 'running', 'starting', 'queued', 'passed'] as const) {
    if (runs.some(run => run.state === state)) return state
  }
  return 'passed' as const
}
