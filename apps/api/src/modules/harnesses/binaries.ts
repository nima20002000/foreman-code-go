import { createRequire } from 'node:module'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

const nativeTargets: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
}
function npmCodexBinary(launcher: string): string | undefined {
  const resolved = realpathSync(launcher)
  const manifest = JSON.parse(readFileSync(join(dirname(resolved), '..', 'package.json'), 'utf8')) as { name?: string }
  if (manifest.name !== '@openai/codex') return undefined
  const target = `${process.platform}-${process.arch}`
  const triple = nativeTargets[target]
  if (!triple) return undefined
  const nativePackage = createRequire(resolved).resolve(`@openai/codex-${target}/package.json`)
  const payload = join(dirname(nativePackage), 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  accessSync(payload, constants.X_OK)
  return realpathSync(payload)
}
function installedCodex(path: string, bundled?: string): string | undefined {
  const excluded = new Set<string>()
  if (bundled) {
    excluded.add(realpathSync(bundled))
    try {
      const payload = npmCodexBinary(bundled)
      if (payload) excluded.add(payload)
    } catch { /* ignore: the bundled optional native package may be absent on this platform. */ }
  }
  for (const directory of path.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
    try {
      accessSync(candidate, constants.X_OK)
      const resolved = realpathSync(candidate)
      if (excluded.has(resolved)) continue
      const prefix = readFileSync(resolved).subarray(0, 4).toString('hex')
      if (prefix === '7f454c46' || prefix.startsWith('4d5a')
        || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(prefix)) return resolved
      const payload = npmCodexBinary(resolved)
      if (payload && !excluded.has(payload)) return payload
    } catch { /* ignore: an unrecognized wrapper is never executed as a trusted default. */ }
  }
  return undefined
}

/** Shared by normal configuration and the DB-free build diagnostic. No fallback provider. */
export function harnessBinaries(environment: NodeJS.ProcessEnv): { codexBinary: string } {
  const codex = environment.CODEX_BINARY === undefined ? 'codex' : environment.CODEX_BINARY.trim()
  if (!codex) throw new Error('Configured harness binaries must not be empty.')
  let bundled: string | undefined
  if (codex === 'codex') {
    try { bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js') }
    catch { /* ignore: standalone workers may provide only their computer-local installation. */ }
  }
  return {
    codexBinary: codex === 'codex'
      ? installedCodex(environment.PATH ?? process.env.PATH ?? '', bundled)
        ?? (environment.CODEX_BINARY === undefined
          ? bundled ?? codex : codex)
      : codex,
  }
}
