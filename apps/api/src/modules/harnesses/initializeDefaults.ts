import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, HarnessDefaultsSchema, operatorHarnessDefaults,
  type HarnessDefaults, type AgentHarness } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { inTransaction } from '../../infrastructure/transaction.js'
import { nativeModelDefaults } from './modelDefaults.js'
import { detectedClaudeProfilePath } from './claudeSdk/productionMetadata.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const missingModel = (value: unknown) => typeof object(value).model !== 'string' || !String(object(value).model).trim()

/** Startup initialization is persisted once under the same settings locks.
 * Existing explicit model/effort/access choices and all immutable pins survive. */
export async function initializeNativeDefaults(input: {
  pool: pg.Pool; options(harness: AgentHarness): Promise<HarnessOptions>; appMcpEndpoint: string
}) {
  const initial = await input.pool.query<{ key: string; record: unknown }>(
    "select key,record from application_settings where key in ('harness-defaults','agent-defaults-v1')")
  const prior = new Map(initial.rows.map(row => [row.key, row.record]))
  const priorHarnesses = object(prior.get('harness-defaults'))
  const required = new Set<AgentHarness>((['codex', 'opencode', 'claude'] as const).filter(harness => missingModel(priorHarnesses[harness])))
  const priorAgents = object(prior.get('agent-defaults-v1'))
  for (const role of ['orchestrator', 'coder', 'operator'] as const) {
    const configuration = object(object(priorAgents[role]).harness)
    if (missingModel(configuration)) required.add((configuration.harness ?? DEFAULT_AGENT_DEFAULTS[role].harness.harness) as AgentHarness)
  }
  const pending = [...required]
  const available = new Map<AgentHarness, HarnessOptions>()
  await Promise.all(pending.map(async harness => {
    try { const options = await input.options(harness); if (options.authenticated && options.models.length) available.set(harness, options) }
    catch { /* An absent or unauthenticated installation remains unconfigured. */ }
  }))
  return inTransaction(input.pool, undefined, async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:harness-defaults'])
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['setting:agent-defaults-v1'])
    const current = await client.query<{ key: string; record: unknown; revision: string }>(
      "select key,record,revision from application_settings where key in ('harness-defaults','agent-defaults-v1') for update")
    const rows = new Map(current.rows.map(row => [row.key, row]))
    const raw = rows.get('harness-defaults')?.record
    const next = { ...DEFAULT_HARNESS_DEFAULTS, ...object(raw) } as HarnessDefaults
    for (const harness of pending) {
      const options = available.get(harness)
      if (!options) continue
      if (!missingModel(object(raw)[harness])) continue
      const base = harness === 'claude' ? { harness: 'claude' as const, model: 'default', configDirectory: detectedClaudeProfilePath(), authMode: 'subscription' as const,
        permissionMode: 'default' as const, sandbox: 'read-only' as const, tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'], permissionRules: [], instructions: '',
        mcpServers: { 'foreman-code': { type: 'http' as const, url: input.appMcpEndpoint } } } : DEFAULT_HARNESS_DEFAULTS[harness]
      next[harness] = nativeModelDefaults({ ...base, ...object(object(raw)[harness]) } as typeof base, options) as never
    }
    const defaults = HarnessDefaultsSchema.parse(next)
    const save = async (key: string, value: unknown, versioned: boolean) => {
      const revision = Number(rows.get(key)?.revision ?? 0) + 1
      const versionId = versioned ? `${key}-v${revision}-${randomUUID()}` : null
      if (versionId) await client.query('insert into application_setting_versions(id,setting_key,version,record) values($1,$2,$3,$4::jsonb)',
        [versionId, key, revision, JSON.stringify(value)])
      await client.query(`insert into application_settings(key,record,revision,current_version_id,updated_at) values($1,$2::jsonb,$3,$4,now())
        on conflict(key) do update set record=excluded.record,revision=excluded.revision,current_version_id=excluded.current_version_id,updated_at=excluded.updated_at`,
      [key, JSON.stringify(value), revision, versionId])
      await client.query("insert into management_audit(principal_id,source,action,target_key,outcome,details) values(null,'system','harness.defaults.initialize',$1,'allowed',$2::jsonb)",
        [key, JSON.stringify({ revision, initializedHarnesses: [...available.keys()] })])
    }
    if (!isDeepStrictEqual(raw ?? DEFAULT_HARNESS_DEFAULTS, defaults)) await save('harness-defaults', defaults, false)
    const rawAgents = rows.get('agent-defaults-v1')?.record
    const agents = { ...DEFAULT_AGENT_DEFAULTS, ...object(rawAgents) }
    let changed = false
    for (const role of ['orchestrator', 'coder', 'operator'] as const) {
      const saved = object(object(rawAgents)[role]), configuration = object(saved.harness)
      if (rawAgents !== undefined && !missingModel(configuration)) continue
      const template = agents[role]
      const harness = (configuration.harness ?? template.harness.harness) as AgentHarness
      const model = defaults[harness]
      if (!model || !available.has(harness)) continue
      const base = template.harness.harness === harness ? template.harness : role === 'operator' ? operatorHarnessDefaults(model) : model
      agents[role] = { ...template, ...saved, harness: nativeModelDefaults({ ...base, ...configuration } as typeof base, available.get(harness)!) } as never
      changed = true
    }
    if (changed) await save('agent-defaults-v1', AgentDefaultsSchema.parse(agents), true)
    return defaults
  })
}
