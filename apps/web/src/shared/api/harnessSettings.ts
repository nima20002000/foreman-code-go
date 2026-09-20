import { useEffect, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  HarnessOptionsResultSchema, HarnessConfigurationCheckResultSchema,
  HarnessMcpListResultSchema, HarnessMcpPlansResultSchema, HarnessMcpPlanResultSchema,
  HarnessMcpManagedInputSchema, HarnessMcpReconcileInputSchema, type HarnessMcpReconcileInput, type HarnessMcpPlan,
  HarnessMcpPlanInputSchema, HarnessMcpPlanSchema, HarnessDirectoryBrowseResultSchema,
  WorkspaceFolderCreateInputSchema, WorkspaceFolderCreateResultSchema, type WorkspaceFolderCreateInput,
  WorkspaceFolderUndoInputSchema, WorkspaceFolderUndoResultSchema, type WorkspaceFolderUndoInput,
  WorkspaceFolderRenameInputSchema, WorkspaceFolderRenameResultSchema, type WorkspaceFolderRenameInput,
  type HarnessMcpPlanInput, type HarnessMcpManagedInput,
} from '@graphql/contracts/management'
import type { HarnessConfiguration } from '@graphql/contracts'
import { apiClient } from './client'
import { sessionGeneration, sessionSignal, sessionIsSwitching, SessionChangedError } from './sessionBoundary'
import { managedMcpFailed, managedMcpSucceeded, reserveManagedMcpOperation, terminalMcpPlan, type ManagedMcpOperation } from './managedMcpOperation'
import { WorkspaceFolderDeleteInputSchema, WorkspaceFolderDeleteResultSchema, type WorkspaceFolderDeleteInput } from '@graphql/contracts/management'

// Each abort rotates the existing session controller synchronously. Re-arm after rotation.
function subscribeSession(changed: () => void) {
  let active = true
  let signal = sessionSignal()
  const abort = () => queueMicrotask(() => {
    if (!active) return
    signal.removeEventListener('abort', abort)
    signal = sessionSignal()
    signal.addEventListener('abort', abort, { once: true })
    changed()
  })
  signal.addEventListener('abort', abort, { once: true })
  return () => { active = false; signal.removeEventListener('abort', abort) }
}
export function useHarnessSessionEpoch() { return useSyncExternalStore(subscribeSession, sessionGeneration, sessionGeneration) }

type Harness = HarnessConfiguration['harness']
export const harnessSettingsKeys = {
  root: ['workbench', 'management', 'harness-settings'] as const,
  options: (harness: Harness) => [...harnessSettingsKeys.root, sessionGeneration(), harness, 'options'] as const,
  check: (snapshot: string) => [...harnessSettingsKeys.root, 'check', sessionGeneration(), snapshot] as const,
  mcp: (harness: Harness) => [...harnessSettingsKeys.root, sessionGeneration(), harness, 'mcp'] as const,
  plans: (harness: Harness) => [...harnessSettingsKeys.root, sessionGeneration(), harness, 'plans'] as const,
}

export function useNativeHarnessOptions(harness: Harness) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.options(harness), enabled: !sessionIsSwitching(), staleTime: 300_000, retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => apiClient.request(`/api/management/harnesses/${harness}/options`, HarnessOptionsResultSchema, { signal }),
  })
}

/** Exact drafts have distinct cache keys. A late result can never qualify a newer selection. */
export function useAutomaticHarnessCheck(configuration: HarnessConfiguration | undefined) {
  useHarnessSessionEpoch()
  const snapshot = configuration ? JSON.stringify(configuration) : ''
  const [settled, setSettled] = useState(snapshot)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(snapshot), 400)
    return () => clearTimeout(timer)
  }, [snapshot])
  const result = useQuery({ queryKey: harnessSettingsKeys.check(settled),
    enabled: !sessionIsSwitching() && Boolean(settled) && snapshot === settled, staleTime: 300_000, retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => apiClient.request('/api/management/harnesses/validate', HarnessConfigurationCheckResultSchema,
      { method: 'POST', body: { configuration: JSON.parse(settled) as HarnessConfiguration }, signal }),
  })
  return { result, current: Boolean(snapshot) && snapshot === settled }
}

export function useRefreshNativeHarness(harness: Harness) {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: () => apiClient.request(`/api/management/harnesses/${harness}/refresh`, HarnessOptionsResultSchema, { method: 'POST', body: {} }),
    onSuccess: async (data) => {
      client.setQueryData(harnessSettingsKeys.options(harness), data)
      await Promise.all([
        client.invalidateQueries({ queryKey: [...harnessSettingsKeys.root, 'check'] }),
        client.invalidateQueries({ queryKey: ['workbench', 'management', 'harnesses'] }),
      ])
    },
  })
}

export function useNativeMcpServers(harness: Harness, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.mcp(harness), enabled: enabled && !sessionIsSwitching(), staleTime: 30_000, retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => apiClient.request(`/api/management/harnesses/${harness}/mcp`, HarnessMcpListResultSchema, { signal }),
  })
}
export function useNativeMcpPlans(harness: Harness, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: harnessSettingsKeys.plans(harness), enabled: enabled && !sessionIsSwitching(), retry: false,
    refetchInterval: enabled ? 10_000 : false,
    queryFn: ({ signal }) => apiClient.request(`/api/management/harnesses/${harness}/mcp/plans`, HarnessMcpPlansResultSchema, { signal }),
  })
}
export function useRequestNativeMcpChange() {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: (input: HarnessMcpPlanInput) => apiClient.request('/api/management/harnesses/mcp/plans', HarnessMcpPlanResultSchema,
      { method: 'POST', body: HarnessMcpPlanInputSchema.parse(input) }),
    onSuccess: async (data) => { await client.invalidateQueries({ queryKey: harnessSettingsKeys.plans(data.value.harness) }) },
  })
}
export function useDecideNativeMcpChange() {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  return useMutation({ retry: false,
    mutationFn: (input: { planId: string; approve: boolean }) => apiClient.request('/api/management/harnesses/mcp/decision', HarnessMcpPlanSchema,
      { method: 'POST', body: input }),
    onSuccess: (plan) => settleManagedOperation(client, epoch, plan),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: harnessSettingsKeys.root }),
        client.invalidateQueries({ queryKey: ['workbench', 'management', 'harnesses'] }),
      ])
    },
  })
}
const managedOperationKey = (harness: Harness, epoch: number) => [...harnessSettingsKeys.root, epoch, harness, 'managed-operation'] as const
function settleManagedOperation(client: QueryClient, epoch: number, plan: HarnessMcpPlan) {
  if (!terminalMcpPlan(plan) || epoch !== sessionGeneration() || sessionIsSwitching()) return
  const key = managedOperationKey(plan.harness, epoch)
  const current = client.getQueryData<ManagedMcpOperation | null>(key)
  if (current?.plan?.id === plan.id) client.setQueryData(key, null)
}

/** Query-client/session lifetime, not the mounted harness panel's lifetime. */
export function useApplyManagedMcpChange(harness: Harness, observedPlans?: HarnessMcpPlan[]) {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  const key = managedOperationKey(harness, epoch)
  const stored = useQuery<ManagedMcpOperation | null>({ queryKey: key, queryFn: () => null,
    enabled: false, initialData: null, staleTime: Infinity, gcTime: Infinity })
  useEffect(() => {
    for (const plan of observedPlans ?? []) settleManagedOperation(client, epoch, plan)
  }, [client, epoch, observedPlans])
  const currentSession = () => epoch === sessionGeneration() && !sessionIsSwitching()
  const update = (input: HarnessMcpManagedInput, transform: (value: ManagedMcpOperation) => ManagedMcpOperation | null) => {
    if (!currentSession()) return
    client.setQueryData<ManagedMcpOperation | null>(key, (current) => current?.input.commandId === input.commandId ? transform(current) : current ?? null)
  }
  const mutation = useMutation({ retry: false,
    mutationFn: (input: HarnessMcpManagedInput) => {
      if (!currentSession()) throw new SessionChangedError()
      const saved = client.getQueryData<ManagedMcpOperation | null>(key)
      if (!saved || JSON.stringify(saved.input) !== JSON.stringify(input)) throw new Error('The original MCP operation is no longer reserved.')
      return apiClient.request('/api/management/harnesses/mcp/managed', HarnessMcpPlanSchema,
        { method: 'POST', body: HarnessMcpManagedInputSchema.parse(input) })
    },
    // Hook-level callbacks run even if a panel unmounts before HTTP settles.
    onSuccess: (plan, input) => update(input, (current) => managedMcpSucceeded(current, plan)),
    onError: (error, input) => update(input, (current) => managedMcpFailed(current, error)),
    onSettled: async () => { if (currentSession()) await Promise.all([
      client.invalidateQueries({ queryKey: harnessSettingsKeys.root }),
      client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] }),
      client.invalidateQueries({ queryKey: ['workbench', 'management', 'harnesses'] }),
    ]) },
  })
  const start = (value: Omit<HarnessMcpManagedInput, 'commandId' | 'harness'>) => {
    if (!currentSession()) return
    if (client.getQueryData<ManagedMcpOperation | null>(key)) return // Never replace an unresolved operation.
    const input = HarnessMcpManagedInputSchema.parse({ ...value, harness, commandId: crypto.randomUUID() })
    client.setQueryData(key, reserveManagedMcpOperation(input))
    mutation.mutate(input)
  }
  const retry = () => {
    const current = client.getQueryData<ManagedMcpOperation | null>(key)
    if (!currentSession() || !current || current.phase === 'sending' || current.phase === 'review') return
    client.setQueryData(key, { ...current, phase: 'sending' })
    mutation.mutate(current.input) // The original revision, payload and ID survive every panel remount.
  }
  return { ...mutation, operation: stored.data, start, retry }
}

export function useReconcileNativeMcpChange() {
  const client = useQueryClient()
  const epoch = useHarnessSessionEpoch()
  return useMutation({ retry: false,
    mutationFn: (input: HarnessMcpReconcileInput) => apiClient.request('/api/management/harnesses/mcp/reconcile', HarnessMcpPlanResultSchema,
      { method: 'POST', body: HarnessMcpReconcileInputSchema.parse(input) }),
    onSuccess: (result) => settleManagedOperation(client, epoch, result.value),
    onSettled: async () => { if (epoch === sessionGeneration() && !sessionIsSwitching()) await Promise.all([
      client.invalidateQueries({ queryKey: harnessSettingsKeys.root }),
      client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] }),
      client.invalidateQueries({ queryKey: ['workbench', 'management', 'harnesses'] }),
    ]) },
  })
}
export function useHarnessDirectories(input: { rootId?: string; path?: string; cursor?: string }, enabled: boolean) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: [...harnessSettingsKeys.root, sessionGeneration(), 'directories', input], enabled: enabled && !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, value)
      return apiClient.request(`/api/management/harnesses/directories?${query}`, HarnessDirectoryBrowseResultSchema, { signal })
    },
  })
}


export function useCreateWorkspaceFolder() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderCreateInput) => apiClient.request('/api/management/harnesses/directories',
      WorkspaceFolderCreateResultSchema, { method: 'POST', body: WorkspaceFolderCreateInputSchema.parse(input) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: harnessSettingsKeys.root }).catch(() => undefined) },
  })
}


export function useRenameWorkspaceFolder() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderRenameInput) => apiClient.request('/api/management/harnesses/directories/rename',
      WorkspaceFolderRenameResultSchema, { method: 'POST', body: WorkspaceFolderRenameInputSchema.parse(input) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: harnessSettingsKeys.root }).catch(() => undefined) },
  })
}

export function useUndoWorkspaceFolder() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderUndoInput) => apiClient.request('/api/management/harnesses/directories/undo',
      WorkspaceFolderUndoResultSchema, { method: 'POST', body: WorkspaceFolderUndoInputSchema.parse(input) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: harnessSettingsKeys.root }) },
  })
}

export function useDeleteWorkspaceFolders() {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: WorkspaceFolderDeleteInput) => apiClient.request('/api/management/harnesses/directories/delete',
      WorkspaceFolderDeleteResultSchema, { method: 'POST', body: WorkspaceFolderDeleteInputSchema.parse(input) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: harnessSettingsKeys.root }) },
  })
}
