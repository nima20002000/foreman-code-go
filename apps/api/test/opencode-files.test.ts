import { it } from 'vitest'
import { registerOpenCodeFileCases } from './support/opencodeFileCases.js'

registerOpenCodeFileCases((name, body) => it(`FIL-09: ${name}`, body))
