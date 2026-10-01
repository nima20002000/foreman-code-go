import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'

describe('backward compatible local binary selection', () => {
  it('preserves bundled Codex for omitted and literal default independent of PATH', () => {
    const bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
    for (const env of [{ PATH: '/unrelated' }, { CODEX_BINARY: 'codex', PATH: '/unrelated' }]) expect(harnessBinaries(env)).toEqual({ codexBinary: bundled, openCodeBinary: 'opencode' })
  })
  it('keeps explicit overrides authoritative and rejects empty selections', () => {
    expect(harnessBinaries({ CODEX_BINARY: '/a path/codex', OPENCODE_BINARY: '/another/opencode' })).toEqual({ codexBinary: '/a path/codex', openCodeBinary: '/another/opencode' })
    expect(() => harnessBinaries({ CODEX_BINARY: ' ' })).toThrow('empty')
    expect(() => harnessBinaries({ OPENCODE_BINARY: '' })).toThrow('empty')
  })
})
