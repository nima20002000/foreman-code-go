import { createRequire } from 'node:module'

/** Shared by normal configuration and the DB-free build diagnostic. No fallback provider. */
export function harnessBinaries(environment: NodeJS.ProcessEnv): { codexBinary: string; openCodeBinary: string } {
  const codex = environment.CODEX_BINARY === undefined ? 'codex' : environment.CODEX_BINARY.trim()
  const opencode = environment.OPENCODE_BINARY === undefined ? 'opencode' : environment.OPENCODE_BINARY.trim()
  if (!codex || !opencode) throw new Error('Configured harness binaries must not be empty.')
  return {
    codexBinary: codex === 'codex' ? createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js') : codex,
    openCodeBinary: opencode,
  }
}
