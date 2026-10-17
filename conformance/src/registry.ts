import { smokeScenarios } from './scenarios/smoke/index.js'
import { mcpScenarios } from './scenarios/mcp/index.js'
import { streamScenarios } from './scenarios/streams/index.js'
import type { Scenario } from './scenario.js'

export { smokeScenarios }

// Add executable, reviewed cases here as each surface is implemented.
// The required coverage inventories remain independent of this registration list.
export const allScenarios: Scenario[] = [...smokeScenarios, ...mcpScenarios, ...streamScenarios]
