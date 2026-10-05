import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'

describe('local binary selection', () => {
  it('falls back to bundled Codex when PATH has no native installation', () => {
    const bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
    expect(harnessBinaries({ PATH: '/unrelated' })).toEqual({ codexBinary: bundled, openCodeBinary: 'opencode' })
    expect(harnessBinaries({ CODEX_BINARY: 'codex', PATH: '/unrelated' }).codexBinary).toBe('codex')
  })
  it('keeps explicit overrides authoritative and rejects empty selections', () => {
    expect(harnessBinaries({ CODEX_BINARY: '/a path/codex', OPENCODE_BINARY: '/another/opencode' })).toEqual({ codexBinary: '/a path/codex', openCodeBinary: '/another/opencode' })
    expect(() => harnessBinaries({ CODEX_BINARY: ' ' })).toThrow('empty')
    expect(() => harnessBinaries({ OPENCODE_BINARY: '' })).toThrow('empty')
  })
})
