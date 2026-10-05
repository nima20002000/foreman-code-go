import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'

describe('local binary selection', () => {
  it('falls back to bundled Codex when PATH has no native installation', () => {
    const bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
    expect(harnessBinaries({ PATH: '/unrelated' })).toEqual({ codexBinary: bundled, openCodeBinary: 'opencode' })
    expect(harnessBinaries({ CODEX_BINARY: 'codex', PATH: '/unrelated' }).codexBinary).toBe('codex')
  })
  it('prefers a computer-local native installation for the default command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-native-selection-'))
    const binary = join(root, 'codex')
    try {
      await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 })
      expect(harnessBinaries({ PATH: root }).codexBinary).toBe(binary)
      expect(harnessBinaries({ PATH: root, CODEX_BINARY: 'codex' }).codexBinary).toBe(binary)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps explicit overrides authoritative and rejects empty selections', () => {
    expect(harnessBinaries({ CODEX_BINARY: '/a path/codex', OPENCODE_BINARY: '/another/opencode' })).toEqual({ codexBinary: '/a path/codex', openCodeBinary: '/another/opencode' })
    expect(() => harnessBinaries({ CODEX_BINARY: ' ' })).toThrow('empty')
    expect(() => harnessBinaries({ OPENCODE_BINARY: '' })).toThrow('empty')
  })
})
