import { access, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Resolve only a directly executable image or the repository's pinned Codex
 * npm launcher algorithm. Arbitrary scripts are visible but not payload-trusted. */
export async function passiveDriverPayloads(driver: string, launcher: string,
  platform: string = process.platform, architecture: string = process.arch): Promise<{ complete: boolean; paths: string[] }> {
  const file = await open(launcher, 'r')
  const prefix = Buffer.alloc(4)
  try { await file.read(prefix, 0, prefix.length, 0) } finally { await file.close() }
  const image = prefix.toString('hex')
  if (image === '7f454c46' || image.startsWith('4d5a')
    || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(image)) return { complete: true, paths: [] }
  if (driver !== 'codex') return { complete: false, paths: [] }
  const local = createRequire(import.meta.url)
  const bundled = await realpath(local.resolve('@openai/codex/bin/codex.js'))
  if (await realpath(launcher) !== bundled) return { complete: false, paths: [] }
  const targets: Record<string, { package: string; triple: string }> = {
    'linux:x64': { package: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
    'linux:arm64': { package: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
    'darwin:x64': { package: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
    'darwin:arm64': { package: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
    'win32:x64': { package: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
    'win32:arm64': { package: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  }
  const target = targets[`${platform === 'android' ? 'linux' : platform}:${architecture}`]
  if (!target) return { complete: false, paths: [] }
  const requireLauncher = createRequire(bundled)
  let vendor: string
  try { vendor = join(dirname(requireLauncher.resolve(`${target.package}/package.json`)), 'vendor') }
  catch { vendor = join(dirname(bundled), '..', 'vendor') }
  const payload = join(vendor, target.triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
  try { await access(payload, constants.X_OK); return { complete: true, paths: [await realpath(payload)] } }
  catch { return { complete: false, paths: [] } }
}
