import { installWorkerLauncher } from './workerMcpLauncher.js'
import { installOperatorLauncher } from './operatorMcpLauncher.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HarnessMcpChange, HarnessMcpManagedPreset } from '@graphql/contracts/management'
import { DomainError } from '../errors.js'
import { ManagedOpenCodeServer } from './opencodeTransport.js'
import { inspectOpenCodeMcpConfiguration } from './opencodeMcpConfiguration.js'
import { parseConfigObject } from './opencodeProtocol.js'
import { editJsoncMcp } from './jsoncMcpEditor.js'
import { backupNativeUserFile, readNativeUserFile, syncNativeConfigDirectory } from './nativeConfigFiles.js'
import { fingerprint, record, replacement, type NativeMcpAdapter, type NativeMcpSnapshot } from './nativeMcpCommon.js'
import { withNativeMcpDelivery } from './nativeMcpDelivery.js'
import { inspectOpenCodeMcpSources } from './openCodeMcpSources.js'

/** Only the native user file is edited, byte-preserving outside the selected MCP member. */
export class OpenCodeMcpConnections implements NativeMcpAdapter {
  constructor(private readonly binary: string, private readonly directory: string, private readonly processRecovery?: NativeProcessRecovery) {}
  private async inspect(signal: AbortSignal): Promise<{ configDirectory: string; effective: Record<string, unknown> }> {
    const server = new ManagedOpenCodeServer({ binary: this.binary, workingDirectory: this.directory, ownerAgentId: `mcp-inspect-${randomUUID()}`, ...(this.processRecovery ? { processRecovery: this.processRecovery } : {}) })
    try {
      await server.ensure(signal)
      const pathResponse = await server.request('/path', { method: 'GET' }, signal)
      const configResponse = await server.request('/config', { method: 'GET' }, signal)
      if (!pathResponse.ok || !configResponse.ok) throw new DomainError('MCP_CONFIG_UNAVAILABLE', 'OpenCode configuration inspection failed.', 503)
      const paths = record(await pathResponse.json())
      const config = record(await configResponse.json())
      if (typeof paths.config !== 'string') throw new DomainError('MCP_USER_CONFIG_UNAVAILABLE', 'OpenCode did not identify its native user configuration directory.', 503)
      return { configDirectory: paths.config, effective: record(config.mcp) }
    } finally { await server.dispose() }
  }
  private async userFile(directory: string): Promise<string> {
    if (await realpath(directory) !== resolve(directory)) throw new DomainError('MCP_CONFIG_SYMLINK', 'Linked native configuration directories are read-only in this manager.', 409)
    for (const name of ['opencode.jsonc', 'opencode.json', 'config.json']) {
      const file = join(directory, name)
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new DomainError('MCP_CONFIG_SYMLINK', 'The native user configuration must be a regular file.', 409)
        return file
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return join(directory, 'opencode.json')
  }
  private contents(file: string): Promise<string> { return readNativeUserFile(file, true) }
  async read(signal: AbortSignal): Promise<NativeMcpSnapshot> {
    const { configDirectory, effective } = await this.inspect(signal)
    const file = await this.userFile(configDirectory)
    const source = await this.contents(file)
    const userConfig = source.trim() ? parseConfigObject(source) : {}
    const user = record(userConfig.mcp)
    const credentialReferences: Record<string, string> = {}
    for (const [name, credential] of [['graphql-operator', 'GRAPHQL_OPERATOR_MCP_TOKEN'], ['graphql-app', 'GRAPHQL_APP_MCP_TOKEN']] as const) {
      if (!Object.hasOwn(user, name) || !Object.hasOwn(effective, name)) continue
      const evidence = await inspectOpenCodeMcpConfiguration({ binary: this.binary, workingDirectory: this.directory,
        serverName: name, credentialEnvironmentVariable: credential, signal })
      const entry = record(effective[name])
      if (!evidence || evidence.endpoint !== entry.url
        || (evidence.transport === 'streamable-http') !== (entry.type === 'remote')
        || evidence.enabled !== (entry.enabled !== false)) {
        throw new DomainError('REVISION_CONFLICT', 'OpenCode configuration changed while credential provenance was inspected.', 409)
      }
      if (evidence.credentialEnvironmentVariable) credentialReferences[name] = evidence.credentialEnvironmentVariable
    }
    const sources = await inspectOpenCodeMcpSources(this.directory, configDirectory, file, user, signal)
    const confirmedSources = await inspectOpenCodeMcpSources(this.directory, configDirectory, file, user, signal)
    if (sources.revision !== confirmedSources.revision) {
      throw new DomainError('REVISION_CONFLICT', 'OpenCode configuration sources changed while inspected.', 409)
    }
    if (await this.contents(file) !== source || await this.userFile(configDirectory) !== file) {
      throw new DomainError('REVISION_CONFLICT', 'Native configuration changed while it was inspected.', 409)
    }
    return { harness: 'opencode', effective, user, userConfig, file, ownership: sources.ownership, credentialReferences,
      version: fingerprint(source), revision: fingerprint([source, effective, file, credentialReferences, sources.revision]) }
  }
  async apply(snapshot: NativeMcpSnapshot, change: HarnessMcpChange, signal: AbortSignal,
    managed?: { preset: HarnessMcpManagedPreset; endpoint: string }): Promise<void> {
    return withNativeMcpDelivery(async (writing) => {
      const next = replacement(snapshot, change, managed)
      const lockPath = `${snapshot.file}.graphql-mcp.lock`
      let lock
      try { lock = await open(lockPath, 'wx', 0o600) } catch { throw new DomainError('MCP_CONFIG_BUSY', 'Native configuration is locked. A crashed writer requires an administrator to reconcile its lock.', 409) }
      const temporary = `${snapshot.file}.graphql-mcp-${randomUUID()}.tmp`
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
        const current = await this.read(signal)
        if (current.revision !== snapshot.revision || current.file !== snapshot.file) throw new DomainError('REVISION_CONFLICT', 'Native MCP configuration changed. Refresh and review a new change.', 409)
        const source = await this.contents(current.file)
        if (fingerprint(source) !== current.version) throw new DomainError('REVISION_CONFLICT', 'The native configuration changed while it was being read.', 409)
        const updated = editJsoncMcp(source, change.name, next)
        const expected = { ...current.user }
        if (next === undefined) delete expected[change.name]; else expected[change.name] = next
        if (fingerprint(parseConfigObject(updated)) !== fingerprint({ ...current.userConfig, mcp: expected })) throw new Error('MCP edit verification failed.')
        await backupNativeUserFile(current.file, source)
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(updated); await handle.sync() } finally { await handle.close() }
        signal.throwIfAborted()
        if (fingerprint(await this.contents(current.file)) !== current.version) throw new DomainError('REVISION_CONFLICT', 'A native editor changed this file. Nothing was overwritten.', 409)
        // The backup and temporary file are not a delivered configuration change.
        writing()
        if (managed?.preset === 'worker' && change.kind === 'add') await installWorkerLauncher()
        if (managed?.preset === 'operator' && change.kind === 'add') await installOperatorLauncher()
        await rename(temporary, current.file)
        await syncNativeConfigDirectory(current.file)
        const written = await readNativeUserFile(current.file)
        if (written !== updated) throw new DomainError('MCP_WRITE_UNCONFIRMED', 'The native write could not be confirmed. Do not retry it automatically.', 409)
      } finally {
        try { await rm(temporary, { force: true }) } finally {
          try { await lock.close() } finally { await rm(lockPath, { force: true }) }
        }
      }
    })
  }
}
