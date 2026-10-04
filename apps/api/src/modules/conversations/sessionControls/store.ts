import { mergeContextSnapshot } from './context.js'
import type pg from 'pg'
import {
  SessionControlRequestSchema, SessionControlStateSchema, SessionPreferencesSchema,
  compactionBlocksSend, unavailableSessionControls,
  type SessionControlState, type SessionControlRequest, type NativeSessionReference,
} from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { DomainError } from '../../errors.js'
import { NativeConversationControlCommands } from '../nativeControlCommands.js'

export interface SessionControlBinding {
  conversationId: string
  principalId: string
  defaultSubject: string
  profileKey: string
  busyReason: string | null
  session?: NativeSessionReference | undefined
  manager?: NativeHarnessSessionManager | undefined
}

export class SessionControlStore {
  private readonly commands: NativeConversationControlCommands<SessionControlState>

  constructor(private readonly pool: Pick<pg.Pool, 'query'>, private readonly role: 'operator' | 'agent') {
    this.commands = new NativeConversationControlCommands(pool, {
      operation: role === 'operator' ? 'operator_chat_control' : 'agent_chat_control',
      parse: value => SessionControlStateSchema.parse(value), prefix: 'SESSION', label: 'Session controls',
    })
  }

  async read(binding: SessionControlBinding): Promise<SessionControlState> {
    const { conversationId, manager, session } = binding
    const capabilities = manager?.sessionControlCapabilities && session
      ? await manager.sessionControlCapabilities(session) : unavailableSessionControls(binding.profileKey)
    const defaultsRow = await this.pool.query<{ record: unknown }>(`select record from conversation_session_defaults
      where principal_id=$1 and role=$2 and subject=$3 and profile_key=$4`,
    [binding.principalId, this.role, binding.defaultSubject, binding.profileKey])
    const defaults = SessionPreferencesSchema.parse(defaultsRow.rows[0]?.record ?? {})
    const initial: SessionControlState = {
      conversationId, revision: 0, profileKey: binding.profileKey,
      desiredMode: 'regular', appliedMode: null, defaults, desired: defaults, applied: null,
      applicability: 'next-turn', capabilities, context: null, compaction: null, busyReason: binding.busyReason,
    }
    await this.pool.query(`insert into conversation_session_controls(conversation_id,record)
      values($1,$2::jsonb) on conflict do nothing`, [conversationId, JSON.stringify(initial)])
    const state = await this.saved(conversationId)
    state.defaults = defaults
    if (manager) state.capabilities = capabilities
    state.busyReason = binding.busyReason
    if (state.profileKey !== binding.profileKey) {
      state.desired = initial.desired
      state.desiredMode = 'regular'
      state.applied = null
      state.appliedMode = null
      state.context = null
      state.applicability = 'new-session'
    }
    if (state.compaction && compactionBlocksSend(state.compaction) && session && manager?.reconcileCompaction) {
      if (state.compaction.nativeSessionId !== session.nativeSessionId) {
        throw new DomainError('SESSION_CONTROL_TARGET_CHANGED', 'The compaction belongs to a different native session.', 409)
      }
      const reconciled = await manager.reconcileCompaction(session, state.compaction)
      if (JSON.stringify(reconciled) !== JSON.stringify(state.compaction)) {
        state.compaction = reconciled
        await this.save(state)
      }
    }
    const context = session ? manager?.contextSnapshot?.(session) : null
    if (context && session) {
      const merged = mergeContextSnapshot(state.context, context, session.nativeSessionId, state.capabilities.model)
      if (JSON.stringify(merged) !== JSON.stringify(state.context)) {
        state.context = merged
        await this.save(state)
      }
    }
    if (state.context && (!session || state.context.nativeSessionId !== session.nativeSessionId)) {
      state.context = { ...state.context, stale: true }
    }
    return state
  }

  async execute(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: SessionControlRequest,
    bind: () => Promise<SessionControlBinding>, signal?: AbortSignal): Promise<SessionControlState> {
    const input = SessionControlRequestSchema.parse(raw)
    const binding = await bind()
    return this.commands.execute(principal, source, binding.conversationId, input.requestId, input,
      async markDispatch => {
        const current = await bind()
        const state = await this.read(current)
        if (state.revision !== input.expectedRevision) {
          throw new DomainError('SESSION_CONTROL_CONFLICT', 'Session settings changed. Refresh and try again.', 409)
        }
        if (state.profileKey !== current.profileKey) {
          throw new DomainError('SESSION_CONTROL_PROFILE_CHANGED', 'The native profile changed. Refresh the conversation.', 409)
        }
        if (compactionBlocksSend(state.compaction)) {
          throw new DomainError('SESSION_COMPACT_UNCONFIRMED', 'Read the pending compaction before sending another command.', 409)
        }
        if (input.kind === 'compact') return this.compact(current, state, input.requestId, markDispatch, signal)
        if (input.kind === 'mode') {
          if (!state.capabilities.plan.supported) {
            throw new DomainError('SESSION_PLAN_UNSUPPORTED', state.capabilities.plan.reason ?? 'Plan is unavailable.', 409)
          }
          state.desiredMode = input.mode
          state.applicability = 'next-turn'
        } else {
          this.validatePreferences(state, input)
          if (input.kind === 'save-default') {
            await this.pool.query(`insert into conversation_session_defaults(principal_id,role,subject,profile_key,record)
              values($1,$2,$3,$4,$5::jsonb) on conflict(principal_id,role,subject,profile_key)
              do update set record=excluded.record`,
            [current.principalId, this.role, current.defaultSubject, current.profileKey, JSON.stringify(input.preferences)])
            state.defaults = input.preferences
          } else {
            state.desired = input.preferences
            state.applicability = current.session ? 'new-session' : 'next-turn'
          }
        }
        await this.save(state)
        return state
      }, async () => this.read(await bind()))
  }

  private async compact(binding: SessionControlBinding, state: SessionControlState, requestId: string,
    markDispatch: () => void, signal?: AbortSignal): Promise<SessionControlState> {
    const progress = async (compaction: NonNullable<SessionControlState['compaction']>) => {
      state.compaction = compaction
      await this.save(state)
    }
    const initial = { requestId, nativeSessionId: binding.session?.nativeSessionId ?? null,
      nativeOperationId: null, status: 'accepted' as const, beforeTokens: null,
      message: 'Compaction is starting.', observedAt: new Date().toISOString() }
    if (!binding.session) {
      await progress({ ...initial, status: 'no-op', message: 'There is no native session to compact yet.' })
      return state
    }
    if (binding.busyReason) throw new DomainError('SESSION_BUSY', binding.busyReason, 409)
    if (!state.capabilities.compact.supported || !binding.manager?.compactSession) {
      throw new DomainError('SESSION_COMPACT_UNSUPPORTED', state.capabilities.compact.reason ?? 'Compaction is unavailable.', 409)
    }
    await progress(initial)
    markDispatch()
    try {
      await progress(await binding.manager.compactSession(binding.session, { requestId, onProgress: progress }, signal))
    } catch (error) {
      const definite = !!error && typeof error === 'object' && 'certainty' in error && error.certainty === 'definite'
      await progress({ ...state.compaction!, status: definite ? 'failed' : 'uncertain',
        message: definite ? 'The native provider rejected compaction.' : 'Compaction is unconfirmed. Recover by reading this conversation.' })
    }
    return state
  }

  private validatePreferences(state: SessionControlState, input: Extract<SessionControlRequest, { kind: 'preferences' | 'save-default' }>) {
    const preferences = input.preferences
    const capabilities = state.capabilities
    if (preferences.autoCompact !== 'default' && !capabilities.autoCompact.supported
      || preferences.autoCompactTokens !== null && !capabilities.autoCompactBudget.supported
      || preferences.contextBudget !== null && !capabilities.contextBudgets.includes(preferences.contextBudget)
      || preferences.contextProfile !== null && !capabilities.contextProfiles.some(profile => profile.id === preferences.contextProfile)) {
      throw new DomainError('SESSION_PREFERENCE_UNSUPPORTED', 'This native profile does not support the selected context option.', 422)
    }
    const budget = preferences.contextBudget ?? preferences.autoCompactTokens
    if (budget !== null && capabilities.modelCapacity !== null && budget > capabilities.modelCapacity) {
      throw new DomainError('SESSION_BUDGET_TOO_LARGE', 'The budget exceeds this model’s supported capacity.', 422)
    }
    if (preferences.contextBudget !== null && state.context?.usedTokens !== null
      && state.context?.usedTokens !== undefined && preferences.contextBudget < state.context.usedTokens) {
      throw new DomainError('SESSION_BUDGET_TOO_SMALL', 'Compact this session before lowering its context budget.', 422)
    }
  }

  async assertSendAllowed(conversationId: string): Promise<void> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    if (result.rows[0] && compactionBlocksSend(SessionControlStateSchema.parse(result.rows[0].record).compaction)) {
      throw new DomainError('SESSION_COMPACT_UNCONFIRMED', 'Compaction is still pending. Read its status before sending.', 409)
    }
  }

  async preferences(conversationId: string) {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    return result.rows[0] ? SessionControlStateSchema.parse(result.rows[0].record).desired : undefined
  }

  async appliedMode(conversationId: string, mode: SessionControlState['desiredMode']) {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    if (!result.rows[0]) return
    const state = SessionControlStateSchema.parse(result.rows[0].record)
    state.appliedMode = mode
    if (state.desiredMode === mode && state.applied && JSON.stringify(state.applied) === JSON.stringify(state.desired)) {
      state.applicability = 'applied'
    }
    await this.save(state)
  }

  async nativePreferencesApplied(conversationId: string) {
    const state = await this.saved(conversationId)
    state.applied = state.desired
    await this.save(state)
  }

  async turnSettings(conversationId: string, selectedMode?: SessionControlState['desiredMode']) {
    await this.assertSendAllowed(conversationId)
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    if (!result.rows[0]) return selectedMode ? { sessionMode: selectedMode } : {}
    const state = SessionControlStateSchema.parse(result.rows[0].record)
    const sessionMode = selectedMode ?? state.desiredMode
    if (selectedMode && state.desiredMode !== selectedMode) {
      state.desiredMode = selectedMode
      await this.save(state)
    }
    return { sessionMode, onSettingsApplied: () => this.appliedMode(conversationId, sessionMode) }
  }

  private async saved(conversationId: string): Promise<SessionControlState> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    return SessionControlStateSchema.parse(result.rows[0]?.record)
  }

  private async save(state: SessionControlState): Promise<void> {
    const revision = state.revision
    const saved = { ...state, revision: revision + 1 }
    const result = await this.pool.query(`update conversation_session_controls set record=$2::jsonb
      where conversation_id=$1 and (record->>'revision')::bigint=$3`,
    [state.conversationId, JSON.stringify(saved), revision])
    if (result.rowCount !== 1) throw new DomainError('SESSION_CONTROL_CONFLICT', 'Session settings changed. Refresh the conversation.', 409)
    state.revision = saved.revision
  }
}
