import { exclusiveIntegrationFiles, requiresUserSystemd, type CiDurations, type CiRunInput,
  type CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { CiIntegrationInventory } from './integrationParts.js'
import { planCiParts, runsOnCircleCi, type CiUnitInventory } from './parts.js'
import { buildComputerIntegrationShards } from './capacity.js'
import { executorSpeedKey, type ExecutorSpeeds } from './executorSpeed.js'
import { withoutReservedCloudSlots } from './cloudSlots.js'

const SETUP_MS = 90_000
const exclusive = new Set(exclusiveIntegrationFiles)
const log = componentLogger('jobs')

interface GateComputer {
  computer: HostCiComputer
  shards: number
  freeSlots: number
  checkMs: number
  files: string[]
}
export interface GatePart {
  suite: CiRunRecord['suite']
  part: CiRunRecord['part']
  partition: CiRunRecord['partition']
  files: string[]
  plannedHostKey: string
  expectedDurationMs: number
  integrationShards?: number
  requiresBuildComputer?: boolean
  speedFactor?: number
}

function integrationTime(files: string[], shards: number, duration: (file: string) => number) {
  const lanes = Array.from({ length: shards }, () => 0)
  let serial = 0
  for (const file of [...files].sort((left, right) => duration(right) - duration(left))) {
    if (exclusive.has(file)) serial += duration(file)
    else {
      const index = lanes.indexOf(Math.min(...lanes))
      lanes[index] = lanes[index]! + duration(file)
    }
  }
  return serial + Math.max(...lanes)
}

export async function readCiComputerStatus(endpoint: HostCiEndpoint, computer: HostCiComputer) {
  const status = await endpoint.request(computer, { operation: 'status' }).catch(error => {
    log.warn({ err: error, computer: computer.key }, 'CI computer status unavailable')
    return null
  })
  return status?.operation === 'status' ? status : null
}

async function gateComputers(endpoint: HostCiEndpoint, reservedCloudSlots: number): Promise<GateComputer[]> {
  const computers = withoutReservedCloudSlots(await endpoint.computers(), reservedCloudSlots)
  const available = await Promise.all(computers.map(async computer => {
    const status = await readCiComputerStatus(endpoint, computer)
    if (!status?.ready) return null
    const shards = buildComputerIntegrationShards(status, computer.buildAllowancePercent)
    const freeSlots = Math.max(0, (status.slotsTotal ?? 1) - (status.slotsUsed ?? 0))
    const available: GateComputer = { computer, shards, freeSlots, checkMs: 0, files: [] }
    return available
  }))
  return available.filter((value): value is GateComputer => value !== null)
}

/** Hosts get one large job each. Cloud takes checks first, then work that extends the hosts' critical path.
 * Learned executor speeds scale each computer's integration time, so slower computers take less work.
 * Reserved cloud slots stay out of the plan so non-gate tickets can start while the gate runs. */
export async function planCiGate(input: CiRunInput, integration: CiIntegrationInventory,
  unit: CiUnitInventory, durations: CiDurations, endpoint: HostCiEndpoint,
  speeds: ExecutorSpeeds = new Map(), reservedCloudSlots = 0, unitSlots?: number): Promise<GatePart[]> {
  const fleet = await gateComputers(endpoint, reservedCloudSlots)
  const hosts = fleet.filter(item => item.computer.hostRef.kind !== 'cloud')
  const clouds = fleet.filter(item => item.computer.hostRef.kind === 'cloud')
  if (!hosts.length || !clouds.length || !integration.files.length) {
    throw new DomainError('CI_GATE_CAPACITY_REQUIRED', 'A gate needs a ready build computer, cloud CI, and integration files.', 409)
  }
  const availableSlots = clouds.reduce((sum, item) => sum + item.freeSlots, 0)
  const slots = Math.min(unitSlots ?? availableSlots, availableSlots)
  const checks = (['typecheck', 'lint', 'unit'] as const).flatMap(suite =>
    planCiParts({ ...input, gate: false, suite, scope: 'full' }, durations, unit, slots).map(part => ({ ...part, suite })))
  const result: GatePart[] = checks.map(part => {
    const eligible = clouds.filter(item => item.computer.hostRef.provider !== 'circleci' || runsOnCircleCi(part))
    const target = [...eligible].sort((left, right) => left.checkMs - right.checkMs)[0]
    if (!target) throw new DomainError('CI_GATE_CAPACITY_REQUIRED', `No cloud executor can run ${part.part ?? part.suite}.`, 409)
    const expectedDurationMs = part.suite === 'unit' ? 210_000 : 150_000
    target.checkMs += expectedDurationMs
    return { ...part, plannedHostKey: target.computer.key, expectedDurationMs }
  })
  const known = Object.values(integration.durations).sort((left, right) => left - right)
  const median = known[Math.floor(known.length / 2)] ?? 30_000
  const duration = (file: string) => integration.durations[file] ?? median
  const files = [...new Set(integration.files)].sort((left, right) => duration(right) - duration(left) || left.localeCompare(right))
  // Longest-first list scheduling over hosts and clouds with incremental shard loads: each file goes where it finishes
  // earliest (hosts win ties), so clouds only take integration that shortens the gate's critical path.
  const load = new Map(fleet.map(item => [item, { lanes: Array.from({ length: item.shards }, () => 0), serial: 0 }]))
  const factor = (item: GateComputer) => speeds.get(executorSpeedKey(item.computer)) ?? 1
  const finishWith = (item: GateComputer, file: string) => {
    const state = load.get(item)!
    const serial = exclusive.has(file) ? state.serial + duration(file) : state.serial
    const lanes = exclusive.has(file) ? Math.max(...state.lanes) : Math.max(Math.max(...state.lanes), Math.min(...state.lanes) + duration(file))
    return item.checkMs + factor(item) * (SETUP_MS + serial + lanes)
  }
  const exclusiveCount = (item: GateComputer) => item.files.filter(file => exclusive.has(file) || requiresUserSystemd(file)).length
  for (const file of files) {
    const serial = exclusive.has(file) || requiresUserSystemd(file)
    const eligible = [...hosts, ...clouds.filter(cloud => !requiresUserSystemd(file) || cloud.computer.userSystemd?.supported)]
    const target = eligible.map((item, order) => ({ item, order, finish: finishWith(item, file) }))
      .sort((left, right) => left.finish - right.finish
        || (serial ? exclusiveCount(left.item) - exclusiveCount(right.item) : 0) || left.order - right.order)[0]!.item
    const state = load.get(target)!
    if (exclusive.has(file)) state.serial += duration(file)
    else {
      const index = state.lanes.indexOf(Math.min(...state.lanes))
      state.lanes[index] = state.lanes[index]! + duration(file)
    }
    target.files.push(file)
  }
  for (const item of fleet.filter(item => item.files.length)) {
    result.push({ suite: 'integration', part: null, partition: null, files: item.files,
      plannedHostKey: item.computer.key, integrationShards: item.shards,
      expectedDurationMs: Math.round(factor(item) * (SETUP_MS + integrationTime(item.files, item.shards, duration))),
      requiresBuildComputer: item.files.some(requiresUserSystemd),
      ...(factor(item) !== 1 ? { speedFactor: factor(item) } : {}) })
  }
  return result
}

/** The oldest unfinished gate owns the full-run barrier across workspaces. */
export function gateQueueBlock(run: CiRunRecord, gate: CiRunRecord | undefined): string | undefined {
  if (!gate || run.groupId === gate.groupId || run.scope === 'affected' && !run.gate) return undefined
  return `Waiting behind CI gate ${gate.groupId}; full requests resume when that gate finishes.`
}

/** Cloud slots share provider capacity; idle build computers help after their own gate part finishes. */
export function gatePartStealer(computers: readonly HostCiComputer[], queued: readonly CiRunRecord[]) {
  const cloudProviders = new Map(computers.filter(computer => computer.hostRef.kind === 'cloud')
    .map(computer => [computer.key, computer.hostRef.provider]))
  const waitingHostGates = new Set(queued.filter(run => run.gate && run.plannedHostKey && !cloudProviders.has(run.plannedHostKey))
    .map(run => run.plannedHostKey))
  return (run: CiRunRecord, computer: HostCiComputer) => {
    if (!run.gate || !run.plannedHostKey || computer.key === run.plannedHostKey) return false
    const plannedForCloud = cloudProviders.has(run.plannedHostKey)
    if (computer.hostRef.kind !== 'cloud') {
      return !waitingHostGates.has(computer.key) && (plannedForCloud || run.suite === 'integration')
    }
    return plannedForCloud && computer.hostRef.provider === cloudProviders.get(run.plannedHostKey)
  }
}
