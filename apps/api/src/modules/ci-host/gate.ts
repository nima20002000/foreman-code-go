import { exclusiveIntegrationFiles, requiresUserSystemd, type CiDurations, type CiRunInput,
  type CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { CiIntegrationInventory } from './integrationParts.js'
import { planCiParts, runsOnCircleCi, type CiUnitInventory } from './parts.js'
import { gateIntegrationShards } from './capacity.js'

const SETUP_MS = 90_000
const TARGET_MS = 300_000
const exclusive = new Set(exclusiveIntegrationFiles)
const log = componentLogger('jobs')

interface GateComputer {
  computer: HostCiComputer
  shards: number
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

async function gateComputers(endpoint: HostCiEndpoint): Promise<GateComputer[]> {
  const computers = await endpoint.computers()
  const available = await Promise.all(computers.map(async computer => {
    const status = await endpoint.request(computer, { operation: 'status' }).catch(error => {
      log.warn({ err: error, computer: computer.key }, 'CI computer unavailable while planning gate')
      return null
    })
    if (status?.operation !== 'status' || !status.ready) return null
    const memory = Math.floor(status.memoryBytes * 0.9)
    const available: GateComputer = { computer, shards: gateIntegrationShards(status.cpuCount, memory), checkMs: 0, files: [] }
    return available
  }))
  return available.filter((value): value is GateComputer => value !== null)
}

/** Hosts get one large job each. Cloud takes checks first, then work that extends the hosts' critical path. */
export async function planCiGate(input: CiRunInput, integration: CiIntegrationInventory,
  unit: CiUnitInventory, durations: CiDurations, endpoint: HostCiEndpoint): Promise<GatePart[]> {
  const fleet = await gateComputers(endpoint)
  const hosts = fleet.filter(item => item.computer.hostRef.kind !== 'cloud')
  const clouds = fleet.filter(item => item.computer.hostRef.kind === 'cloud')
  if (!hosts.length || !clouds.length || !integration.files.length) {
    throw new DomainError('CI_GATE_CAPACITY_REQUIRED', 'A gate needs a ready build computer, cloud CI, and integration files.', 409)
  }
  const checks = (['typecheck', 'lint', 'unit'] as const).flatMap(suite =>
    planCiParts({ ...input, gate: false, suite, scope: 'full' }, durations, unit).map(part => ({ ...part, suite })))
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
  const finish = (item: GateComputer, files = item.files) => item.checkMs
    + (files.length ? SETUP_MS + integrationTime(files, item.shards, duration) : 0)
  const files = [...new Set(integration.files)].sort((left, right) => duration(right) - duration(left) || left.localeCompare(right))
  const exclusiveCount = (item: GateComputer) => item.files.filter(file => exclusive.has(file) || requiresUserSystemd(file)).length
  for (const file of files) {
    const serial = exclusive.has(file) || requiresUserSystemd(file)
    const target = [...hosts].sort((left, right) => (serial ? exclusiveCount(left) - exclusiveCount(right) : 0)
      || finish(left, [...left.files, file]) - finish(right, [...right.files, file]))[0]!
    target.files.push(file)
  }
  const checkCritical = Math.max(...clouds.map(item => item.checkMs))
  const targetMs = Math.max(checkCritical, TARGET_MS)
  while (Math.max(...hosts.map(item => finish(item))) > targetMs) {
    const host = [...hosts].sort((left, right) => finish(right) - finish(left))[0]!
    const critical = Math.max(...fleet.map(item => finish(item)))
    let move: { file: string; cloud: GateComputer; score: number } | undefined
    for (const file of host.files) {
      const remaining = host.files.filter(candidate => candidate !== file)
      if (!remaining.length || finish(host, remaining) >= finish(host)) continue
      for (const cloud of clouds) {
        if (requiresUserSystemd(file) && !cloud.computer.userSystemd?.supported) continue
        const score = Math.max(...fleet.map(item => {
          if (item === host) return finish(host, remaining)
          if (item === cloud) return finish(cloud, [...cloud.files, file])
          return finish(item)
        }))
        if (score > critical || move && score >= move.score) continue
        move = { file, cloud, score }
      }
    }
    if (!move) break
    host.files = host.files.filter(file => file !== move.file)
    move.cloud.files.push(move.file)
  }
  for (const item of fleet.filter(item => item.files.length)) {
    result.push({ suite: 'integration', part: null, partition: null, files: item.files,
      plannedHostKey: item.computer.key, integrationShards: item.shards,
      expectedDurationMs: SETUP_MS + integrationTime(item.files, item.shards, duration),
      requiresBuildComputer: item.files.some(requiresUserSystemd) })
  }
  return result
}

/** The oldest unfinished gate owns the full-run barrier across workspaces. */
export function gateQueueBlock(run: CiRunRecord, gate: CiRunRecord | undefined): string | undefined {
  if (!gate || run.groupId === gate.groupId || run.scope === 'affected' && !run.gate) return undefined
  return `Waiting behind CI gate ${gate.groupId}; full requests resume when that gate finishes.`
}
