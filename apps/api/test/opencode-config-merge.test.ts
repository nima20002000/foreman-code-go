import assert from 'node:assert/strict'
import { it } from 'vitest'

import { buildOpenCodeConfigContent } from '../src/modules/harnesses/opencodeServer.js'
import { advanced } from './opencode-fixtures.js'

it('[F25] merges valid JSONC comments and trailing commas without corrupting quoted text', () => {
  const source = `{
    // Native inline config accepts JSONC.
    "model": "provider/model", "url": "https://host/path//not-a-comment",
    "note": "escaped quote: \\\u0022 /* still string */",
    "plugin": ["one",], /* block comment */
    "compaction": { "custom": true, },
  }`
  const selected = { ...advanced(), subagentDepth: 0, compaction: { auto: false, prune: true, tailTurns: 4, preserveRecentTokens: 2_048 } }
  const result = JSON.parse(buildOpenCodeConfigContent(source, selected))
  assert.equal(result.url, 'https://host/path//not-a-comment')
  assert.deepEqual(result.plugin, ['one'])
  assert.deepEqual(result.compaction, { custom: true, auto: false, prune: true, tail_turns: 4, preserve_recent_tokens: 2_048 })
  assert.equal(result.subagent_depth, 0)
})
