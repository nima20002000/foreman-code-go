import { createRequire } from 'node:module'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

function installedCodex(path: string): string | undefined {
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
    try {
      accessSync(candidate, constants.X_OK)
      const prefix = readFileSync(candidate).subarray(0, 4).toString('hex')
      if (prefix === '7f454c46' || prefix.startsWith('4d5a')
        || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(prefix)) return candidate
      const requireLauncher = createRequire(realpathSync(candidate))
      const manifest = JSON.parse(readFileSync(join(dirname(realpathSync(candidate)), '..', 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name !== '@openai/codex') continue
      const triples: Record<string, string> = {
        'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
        'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
        'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
      }
      const target = `${process.platform}-${process.arch}`
      if (!triples[target]) continue
      const nativePackage = requireLauncher.resolve(`@openai/codex-${target}/package.json`)
      const payload = join(dirname(nativePackage), 'vendor', triples[target], 'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex')
      accessSync(payload, constants.X_OK)
      return payload
    } catch { /* An unrecognized wrapper is never executed as a trusted default. */ }
  }
  return undefined
}

/** Shared by normal configuration and the DB-free build diagnostic. No fallback provider. */
export function harnessBinaries(environment: NodeJS.ProcessEnv): { codexBinary: string; openCodeBinary: string } {
  const codex = environment.CODEX_BINARY === undefined ? 'codex' : environment.CODEX_BINARY.trim()
  const opencode = environment.OPENCODE_BINARY === undefined ? 'opencode' : environment.OPENCODE_BINARY.trim()
  if (!codex || !opencode) throw new Error('Configured harness binaries must not be empty.')
  return {
    codexBinary: codex === 'codex'
      ? installedCodex(environment.PATH ?? process.env.PATH ?? '')
        ?? (environment.CODEX_BINARY === undefined
          ? createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js') : codex)
      : codex,
    openCodeBinary: opencode,
  }
}
