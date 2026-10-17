import { resolve } from 'node:path'
import { LANES, type Lane, type Target } from './reporting/types.js'
import { readTarget } from './runtime/target.js'

export interface SuiteOptions {
  target: Target
  smoke: boolean
  lanes: Lane[]
  scenarioIds: string[]
  output: string
  list: boolean
}

export function parseOptions(args: readonly string[], repoRoot: string, environment: NodeJS.ProcessEnv): SuiteOptions {
  const options: SuiteOptions = {
    target: readTarget(environment), smoke: false, lanes: [], scenarioIds: [], list: false,
    output: resolve(repoRoot, environment.CONFORMANCE_RESULTS_FILE ?? `conformance/results/${readTarget(environment)}.json`),
  }
  let explicitOutput = environment.CONFORMANCE_RESULTS_FILE !== undefined
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (flag === '--smoke') { options.smoke = true; continue }
    if (flag === '--list') { options.list = true; continue }
    if (!['--target', '--output', '--lane', '--scenario'].includes(flag)) throw new Error(`Unknown option: ${flag}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--target') {
      options.target = readTarget({ CONFORMANCE_TARGET: value })
      continue
    }
    if (flag === '--output') { options.output = resolve(repoRoot, value); explicitOutput = true; continue }
    if (flag === '--scenario') { options.scenarioIds.push(value); continue }
    for (const lane of value.split(',')) {
      if (!LANES.includes(lane as Lane)) throw new Error(`Unknown lane: ${lane}`)
      if (!options.lanes.includes(lane as Lane)) options.lanes.push(lane as Lane)
    }
  }
  if (!explicitOutput) options.output = resolve(repoRoot, `conformance/results/${options.target}.json`)
  return options
}
