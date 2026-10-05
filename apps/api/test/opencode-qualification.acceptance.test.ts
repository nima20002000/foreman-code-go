import { it } from 'vitest'
import { qualifyEng03OpenCode } from './helpers/eng03OpenCodeQualification.js'

it('qualifies OpenCode through the audited service and reads back persisted trust', async () => {
  const close = await qualifyEng03OpenCode()
  await close()
}, 360_000)
