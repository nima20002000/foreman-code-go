// Prints one duration-balanced slice of the integration files: node scripts/ci-shard.mjs <index> <count>
import { readFileSync } from 'node:fs'
import { discoverFiles } from './test-integration.mjs'
import { integrationPartition } from './verification-runner.mjs'

const [index, count] = process.argv.slice(2).map(Number)
if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) {
  throw new Error('usage: ci-shard.mjs <index> <count>')
}
const durations = JSON.parse(readFileSync(new URL('integration-durations.json', import.meta.url), 'utf8'))
console.log(integrationPartition(discoverFiles(), durations, { index, count }).join(' '))
