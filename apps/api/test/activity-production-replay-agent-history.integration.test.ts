import { afterEach, describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay } from './helpers/activityReplayFixture.js'
import { replayChatHistory } from './helpers/activityReplayChatHistory.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: agent-history', { timeout: 120000 }, () => {
  const selected = false
  it(`${selected ? 'selected Run' : 'Agent'}: older active/newer queued, final empty, replay and restart preserve exact source`,
    () => replayChatHistory({ selectedRun: selected }))
})
