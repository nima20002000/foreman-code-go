import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, open, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'

export interface ClaudeInstallationInventory {
  installed: boolean
  requestedExecutable: string
  resolvedExecutable?: string
  executableSha256?: string
  interpreter?: string
  platform: string
  architecture: string
  profilePath: string
  configRevision: string
  /** Filesystem inventory never launches a child or reads provider credentials. */
  evidenceKind: 'filesystem-inventory'
  versionKnown: false
  authenticated: 'unknown'
  modelQualified: false
  graphqlReady: false
  diagnostics: string[]
}
function safeCandidates(binary: string, path: string): string[] {
  if (isAbsolute(binary)) return [binary]
  if (binary.includes('/') || binary.includes('\0')) return []
  return path.split(delimiter).filter((entry) => isAbsolute(entry) && !entry.includes('\0')).slice(0, 64).map((entry) => join(entry, binary))
}
async function findExecutable(binary: string, path: string): Promise<string | undefined> {
  for (const candidate of safeCandidates(binary, path)) {
    try {
      await access(candidate, constants.X_OK)
      const resolved = await realpath(candidate)
      if ((await stat(resolved)).isFile()) return resolved
    } catch { /* ignore: bounded safe PATH lookup; never source shell startup files. */ }
  }
  return undefined
}
export async function discoverClaudeInstallation(input: {
  executable?: string
  path: string
  profilePath: string
  configRevision: string
  platform?: string
  architecture?: string
}): Promise<ClaudeInstallationInventory> {
  const requestedExecutable = input.executable ?? 'claude'
  const result: ClaudeInstallationInventory = {
    requestedExecutable, installed: false, evidenceKind: 'filesystem-inventory',
    platform: input.platform ?? process.platform, architecture: input.architecture ?? process.arch,
    profilePath: input.profilePath, configRevision: input.configRevision, versionKnown: false,
    authenticated: 'unknown', modelQualified: false, graphqlReady: false, diagnostics: [],
  }
  const executable = await findExecutable(requestedExecutable, input.path)
  if (!executable) { result.diagnostics.push('Selected Claude executable is unavailable or not executable.'); return result }
  const file = await open(executable, 'r')
  let prefix: string
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    prefix = buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
  if (prefix.startsWith('#!')) {
    const parts = prefix.split('\n')[0]!.slice(2).trim().split(/\s+/)
    const interpreter = parts[0] === '/usr/bin/env' ? parts[1] : parts[0]
    if (!interpreter || interpreter.startsWith('-')) { result.diagnostics.push('Claude launcher has an unsupported interpreter declaration.'); return result }
    const resolved = await findExecutable(interpreter, input.path)
    if (!resolved) { result.diagnostics.push('Claude launcher interpreter is unavailable.'); return result }
    result.interpreter = resolved
  }
  const sha256 = createHash('sha256')
  const fileStat = await stat(executable)
  if (fileStat.size > 512 * 1024 * 1024) { result.diagnostics.push('Claude executable exceeds the bounded inventory size.'); return result }
  for await (const chunk of createReadStream(executable)) sha256.update(chunk)
  result.installed = true
  result.resolvedExecutable = executable
  result.executableSha256 = sha256.digest('hex')
  if (result.interpreter) result.diagnostics.push('Launcher fingerprint alone does not qualify an interpreter or native payload.')
  return result
}

export interface ClaudeVersionEvidence {
  evidenceKind: 'owned-version-probe'
  binary: string
  version?: string
  authenticated: 'unknown'
  graphqlReady: false
  diagnostic?: string
}
/** Explicit owned probe. --version is neither authentication nor native capability evidence. */
export async function probeClaudeVersion(input: {
  inventory: ClaudeInstallationInventory
  neutralDirectory: string
  environment: Readonly<Record<string, string>>
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ClaudeVersionEvidence> {
  input.signal?.throwIfAborted()
  const binary = input.inventory.resolvedExecutable
  if (!input.inventory.installed || !binary) throw new Error('Claude installation inventory is unavailable')
  if (!isAbsolute(input.neutralDirectory)) throw new Error('Claude probe requires an absolute neutral directory')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--version'], { cwd: input.neutralDirectory, env: { ...input.environment }, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let output = ''
    let exceeded = false
    let stopped = false
    let failure: unknown
    let force: ReturnType<typeof setTimeout> | undefined
    const stop = (error: unknown) => {
      if (stopped) return
      stopped = true
      failure = error
      child.kill('SIGTERM')
      force = setTimeout(() => child.kill('SIGKILL'), 250)
    }
    const deadline = setTimeout(() => stop(new Error('Claude version probe timed out')), input.timeoutMs ?? 5000)
    const aborted = () => stop(input.signal?.reason ?? new Error('Claude version probe aborted'))
    input.signal?.addEventListener('abort', aborted, { once: true })
    const data = (chunk: Buffer) => {
      if (output.length + chunk.length > 8192) { exceeded = true; stop(new Error('Claude version probe output exceeded limit')); return }
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', data)
    child.stderr.on('data', data)
    child.on('error', (error) => { failure = error })
    child.once('close', (code) => {
      clearTimeout(deadline)
      if (force) clearTimeout(force)
      input.signal?.removeEventListener('abort', aborted)
      child.stdout.removeListener('data', data)
      child.stderr.removeListener('data', data)
      if (failure) { reject(failure); return }
      const version = /^\s*(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?\s*$/u.exec(output)?.[1]
      resolve({ evidenceKind: 'owned-version-probe', binary, authenticated: 'unknown', graphqlReady: false,
        ...(code === 0 && !exceeded && version ? { version } : { diagnostic: 'Claude version output is not a successful recognized version response.' }) })
    })
  })
}
