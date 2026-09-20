import type pg from 'pg'
import {
  CodexPluginChangeInputSchema, CodexPluginChangeResultSchema, CodexPluginDetailResultSchema,
  CodexPluginGetInputSchema, CodexPluginListInputSchema, CodexPluginListResultSchema,
  type CodexPluginChangeInput, type CodexPluginListInput, type ManagementPrincipal,
} from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { CodexPluginAdapter } from './codexPlugins.js'

/** Codex remains the plugin source of truth; receipts only prevent replaying an uncertain native write. */
export class CodexPluginSettingsService {
  private readonly stopping = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  constructor(private readonly pool: pg.Pool, private readonly adapter: CodexPluginAdapter) {}
  private async track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }
  private async liveOwner(principal: ManagementPrincipal, client: pg.Pool | pg.PoolClient = this.pool): Promise<void> {
    if (principal.audience !== 'operator') throw new DomainError('CODEX_PLUGIN_BROWSER_REQUIRED', 'A signed-in owner must change Codex plugins.', 403)
    const result = await client.query<{ grants: ManagementPrincipal['grants']; expires_at: Date }>(
      "select grants,expires_at from management_principals where id=$1 and audience='operator' and delegated_from is null and revoked_at is null and expires_at>now()",
      [principal.id])
    if (!result.rows[0]) throw new DomainError('CODEX_PLUGIN_BROWSER_REQUIRED', 'A signed-in owner must change Codex plugins.', 403)
    requireAuthorization({ ...principal, grants: result.rows[0].grants, expiresAt: result.rows[0].expires_at.toISOString() }, 'harnesses:update')
  }

  async list(principal: ManagementPrincipal, raw: CodexPluginListInput) {
    requireAuthorization(principal, 'harnesses:read')
    const input = CodexPluginListInputSchema.parse(raw)
    const catalog = await this.adapter.list(this.stopping.signal)
    const query = input.query.toLocaleLowerCase()
    const items = catalog[input.view].filter((plugin) => !query || `${plugin.name} ${plugin.marketplaceName}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.marketplaceName.localeCompare(b.marketplaceName))
    const slice = items.slice(input.offset, input.offset + input.limit)
    return CodexPluginListResultSchema.parse({ items: slice, total: items.length,
      nextOffset: input.offset + input.limit < items.length ? input.offset + input.limit : null,
      revision: catalog.revision, checkedAt: new Date().toISOString() })
  }

  async get(principal: ManagementPrincipal, pluginId: string) {
    requireAuthorization(principal, 'harnesses:read')
    const { pluginId: id } = CodexPluginGetInputSchema.parse({ pluginId })
    const catalog = await this.adapter.list(this.stopping.signal)
    const plugin = [...catalog.installed, ...catalog.available].find((item) => item.pluginId === id)
    if (!plugin) throw new DomainError('CODEX_PLUGIN_NOT_FOUND', 'This plugin is no longer in the Codex catalog.', 404)
    return CodexPluginDetailResultSchema.parse({ plugin, contents: await this.adapter.detail(plugin) })
  }

  change(principal: ManagementPrincipal, raw: CodexPluginChangeInput) {
    return this.track(this.applyChange(principal, raw).catch(async (error: unknown) => {
      await this.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,'http','codex.plugin.change',$2,'failed',$3::jsonb)`, [principal.id, `codex-plugin:${raw.pluginId}`,
        JSON.stringify({ commandId: raw.commandId, code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })]).catch(() => undefined)
      throw error
    }))
  }
  private async applyChange(principal: ManagementPrincipal, raw: CodexPluginChangeInput) {
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
    await this.liveOwner(principal)
    const input = CodexPluginChangeInputSchema.parse(raw)
    const operation = 'codex.plugin.change'
    const target = `codex-plugin:${input.pluginId}`
    const hash = commandInputHash(input)
    const client = await this.pool.connect()
    let locked = false
    try {
      const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext('graphql:codex-plugins')) as locked")
      locked = lock.rows[0]?.locked === true
      if (!locked) throw new DomainError('CODEX_PLUGIN_BUSY', 'Another plugin change is in progress.', 409)
      const existing = await client.query<{ input_hash: string; target_key: string; result: unknown }>(
        'select input_hash,target_key,result from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
        [principal.id, operation, input.commandId])
      if (existing.rows[0]) {
        if (existing.rows[0].input_hash !== hash || existing.rows[0].target_key !== target)
          throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
        return CodexPluginChangeResultSchema.parse(existing.rows[0].result)
      }
      const before = await this.adapter.list(this.stopping.signal)
      if (before.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Codex plugins changed. Refresh before trying again.', 409)
      const plugin = [...before.installed, ...before.available].find((item) => item.pluginId === input.pluginId)
      if (!plugin) throw new DomainError('CODEX_PLUGIN_NOT_FOUND', 'This plugin is no longer in the Codex catalog.', 404)
      if (input.action === 'install' && (plugin.installed || plugin.installPolicy !== 'AVAILABLE'))
        throw new DomainError('CODEX_PLUGIN_INSTALL_UNAVAILABLE', 'Codex does not offer this plugin for installation.', 409)
      if (input.action === 'remove' && (!plugin.installed || plugin.installPolicy === 'INSTALLED_BY_DEFAULT'))
        throw new DomainError('CODEX_PLUGIN_REMOVE_UNAVAILABLE', 'This plugin cannot be removed from Codex here.', 409)
      const uncertain = CodexPluginChangeResultSchema.parse({ pluginId: input.pluginId, action: input.action, status: 'uncertain',
        message: 'The native change may have happened. Refresh the plugin list before another action.' })
      await client.query('begin')
      try {
        await client.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
          values($1,$2,$3,$4,$5,$6::jsonb)`, [principal.id, operation, input.commandId, target, hash, JSON.stringify(uncertain)])
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,'http',$2,$3,'uncertain',$4::jsonb)`, [principal.id, operation, target, JSON.stringify({ commandId: input.commandId })])
        await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error }
      await this.liveOwner(principal, client)
      try { await this.adapter.change(input.pluginId, input.action, this.stopping.signal) }
      catch { /* Readback decides whether the native operation completed. */ }
      let confirmed = false
      try {
        const after = await this.adapter.list(this.stopping.signal)
        confirmed = after.installed.some((item) => item.pluginId === input.pluginId) === (input.action === 'install')
      } catch { /* Preserve the durable uncertain receipt. */ }
      if (!confirmed) return uncertain
      const applied = CodexPluginChangeResultSchema.parse({ pluginId: input.pluginId, action: input.action, status: 'applied',
        message: input.action === 'install' ? 'Installed in Codex. A new session and service sign-in may be needed.'
          : 'Removed from Codex. Separately configured MCP connections remain installed.' })
      await client.query('begin')
      try {
        await client.query(`update management_command_receipts set result=$4::jsonb
          where principal_id=$1 and operation=$2 and command_id=$3`, [principal.id, operation, input.commandId, JSON.stringify(applied)])
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,'http',$2,$3,'succeeded',$4::jsonb)`, [principal.id, operation, target, JSON.stringify({ commandId: input.commandId })])
        await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error }
      return applied
    } finally {
      const unlocked = locked ? await client.query("select pg_advisory_unlock(hashtext('graphql:codex-plugins'))").then(() => true, () => false) : true
      client.release(!unlocked)
    }
  }

  async shutdown() { this.stopping.abort(); await Promise.allSettled([...this.pending]) }
}
