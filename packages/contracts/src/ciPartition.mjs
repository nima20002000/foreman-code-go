import { exclusiveIntegrationFiles, requirements } from './integrationScheduling.mjs'

/** Spread capability-dependent and host-exclusive files before balancing the remaining durations by computer speed.
 * Files without a recorded duration count as the median.
 * @param {readonly string[]} files
 * @param {Readonly<Record<string, number>>} durations
 * @param {import('./ciHost.js').CiPartition} partition
 * @returns {string[]} */
export function integrationPartition(files, durations, partition) {
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value > 0
  const known = files.map(file => durations[file]).filter(valid).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1
  const weight = file => valid(durations[file]) ? durations[file] : fallback
  const loads = Array(partition.count).fill(0)
  const speed = index => partition.weights?.[index] ?? 1
  const owner = new Map()
  const heavy = new Set([...requirements.keys(), ...exclusiveIntegrationFiles])
  const heavyCounts = Array(partition.count).fill(0)
  const ordered = [...files].sort((left, right) => Number(heavy.has(right)) - Number(heavy.has(left))
    || weight(right) - weight(left) || (left < right ? -1 : 1))
  for (const file of ordered) {
    // Heavy files use each partition once per round before host speed breaks ties.
    const isHeavy = heavy.has(file)
    const hostRequired = requirements.get(file)?.includes('installedWorkerHost')
    const eligible = hostRequired && partition.hostIndexes
      ? partition.hostIndexes : Array.from({ length: partition.count }, (_, index) => index)
    let lightest = eligible[0]
    const finish = index => (loads[index] + weight(file)) / speed(index)
    for (const index of eligible.slice(1)) {
      const fewerHeavy = isHeavy && heavyCounts[index] < heavyCounts[lightest]
      const sameHeavy = !isHeavy || heavyCounts[index] === heavyCounts[lightest]
      if (fewerHeavy || (sameHeavy && finish(index) < finish(lightest))) lightest = index
    }
    if (isHeavy) heavyCounts[lightest]++
    loads[lightest] += weight(file)
    owner.set(file, lightest)
  }
  return files.filter(file => owner.get(file) === partition.index)
}
