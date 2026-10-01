import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  WorkspaceRootListResultSchema, WorkspaceRootSelectionSchema,
  type ApprovedRootAllowlist, type WorkspaceRootSelection,
} from '@graphql/contracts/workspace-root-policies'
import {
  WorkspaceBoundLocationReadbackSchema, WorkspaceBoundLocationSetInputSchema, WorkspaceBoundLocationSetResultSchema,
  WorkspaceBoundLocationValidationSchema, WorkspaceBoundLocationBrowseResultSchema,
  type WorkspaceBoundLocationReadback, type WorkspaceBoundLocationSetInput,
} from '@graphql/contracts/workspace-bound-location'
import { ApiError, apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { locationMutationKey } from './workspaceLocationCache'
import { queryKeys } from './query'

export const boundLocationKeys = {
  root: ['workbench', 'bound-workspace-location'] as const,
  scope: (workspaceId: string, generation = sessionGeneration()) => [...boundLocationKeys.root, generation, workspaceId] as const,
  read: (workspaceId: string, generation = sessionGeneration()) => [...boundLocationKeys.scope(workspaceId, generation), 'read'] as const,
  choices: (workspaceId: string) => [...boundLocationKeys.scope(workspaceId), 'choices'] as const,
}
const path = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}`
export function sameRootSelection(left: WorkspaceRootSelection | undefined, right: WorkspaceRootSelection | undefined) {
  const before = WorkspaceRootSelectionSchema.safeParse(left), after = WorkspaceRootSelectionSchema.safeParse(right)
  return before.success && after.success && JSON.stringify(before.data) === JSON.stringify(after.data)
}
function invalid(message: string): never { throw new ApiError({ code: 'INVALID_RESPONSE', message }) }
function checkHost(left: WorkspaceRootSelection['hostRef'], right: WorkspaceRootSelection['hostRef']) {
  return left.kind === right.kind && left.mainId === right.mainId && (left.kind === 'main' || right.kind === 'device' && left.deviceId === right.deviceId)
}
export function useWorkspaceRootChoices(workspaceId: string, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: boundLocationKeys.choices(workspaceId), enabled: enabled && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(`${path(workspaceId)}/root-policies`, WorkspaceRootListResultSchema, { signal })
      if (result.workspaceId !== workspaceId || result.policies.some(value => value.workspaceId !== workspaceId)) invalid('Root choices belong to another workspace.')
      return result
    } })
}
export function useBoundWorkspaceLocation(workspaceId: string, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: boundLocationKeys.read(workspaceId), enabled: enabled && !sessionIsSwitching(), retry: false,
    structuralSharing: (previous, incoming) => {
      const before = previous as WorkspaceBoundLocationReadback | undefined, next = incoming as WorkspaceBoundLocationReadback
      return before && before.locationRevision > next.locationRevision ? before : next
    },
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(`${path(workspaceId)}/root-location`, WorkspaceBoundLocationReadbackSchema, { signal })
      if (result.workspaceId !== workspaceId || result.evidence === 'bound' && result.binding.workspaceId !== workspaceId) invalid('Bound location belongs to another workspace.')
      return result
    } })
}
/** Expected host metadata is a client acknowledgement fence, never sent as authority. */
type ReadRequest = { input: WorkspaceRootSelection; expectedHost: ApprovedRootAllowlist }
function checkRequestHost(input: WorkspaceRootSelection, host: ApprovedRootAllowlist, workspaceId: string) {
  if (input.workspaceId !== workspaceId || !checkHost(input.hostRef, host.hostRef) || input.configurationRevision !== host.configurationRevision
    || !host.bases.some(base => base.baseId === input.allowedBaseId && base.accessModes.includes(input.accessMode)))
    throw new ApiError({ code: 'INVALID_REQUEST', message: 'Select a current approved root for this workspace and computer.' })
}
export function useBrowseBoundWorkspaceLocation(workspaceId: string) {
  return useMutation({ mutationKey: [...boundLocationKeys.scope(workspaceId), 'browse'], mutationFn: async ({ input, expectedHost }: ReadRequest) => {
    checkRequestHost(input, expectedHost, workspaceId)
    const result = await apiClient.request(`${path(workspaceId)}/root-location/browse`, WorkspaceBoundLocationBrowseResultSchema,
      { method: 'POST', body: WorkspaceRootSelectionSchema.parse(input) })
    if (result.workspaceId !== workspaceId || !sameRootSelection(result.selection, input) || !checkHost(input.hostRef, expectedHost.hostRef)) invalid('Directory readback belongs to another root selection.')
    return result
  } })
}
export function useValidateBoundWorkspaceLocation(workspaceId: string) {
  return useMutation({ mutationKey: [...boundLocationKeys.scope(workspaceId), 'validate'], mutationFn: async ({ input, expectedHost }: ReadRequest) => {
    checkRequestHost(input, expectedHost, workspaceId)
    const result = await apiClient.request(`${path(workspaceId)}/root-location/validate`, WorkspaceBoundLocationValidationSchema,
      { method: 'POST', body: WorkspaceRootSelectionSchema.parse(input) })
    const proof = result.attestation
    if (result.workspaceId !== workspaceId || !sameRootSelection(result.selection, input) || !checkHost(proof.hostRef, input.hostRef)
      || proof.applicationInstallationId !== expectedHost.applicationInstallationId || proof.allowedBaseId !== input.allowedBaseId
      || proof.configurationRevision !== input.configurationRevision || proof.relativePath !== input.relativePath || proof.accessMode !== input.accessMode)
      invalid('Folder validation does not match the selected computer and approved root.')
    return result
  } })
}
export function useSetBoundWorkspaceLocation(workspaceId: string) {
  const client = useQueryClient(), generation = useHarnessSessionEpoch()
  return useMutation({ mutationKey: [...locationMutationKey(workspaceId), generation, 'bound-set'],
    mutationFn: async ({ input, expectedHost }: { input: WorkspaceBoundLocationSetInput; expectedHost: ApprovedRootAllowlist }) => {
      checkRequestHost(input, expectedHost, workspaceId)
      const parsed = WorkspaceBoundLocationSetInputSchema.safeParse(input)
      if (!parsed.success) throw new ApiError({ code: 'INVALID_REQUEST', message: 'The selected folder request is invalid.', details: { issues: parsed.error.issues } })
      const result = await apiClient.request(`${path(workspaceId)}/root-location`, WorkspaceBoundLocationSetResultSchema,
        { method: 'PUT', body: parsed.data })
      const value = result.value
      if (value.evidence !== 'bound' || value.workspaceId !== workspaceId || value.binding.workspaceId !== workspaceId) invalid('The submitted workspace root binding was not confirmed.')
      const binding = value.binding
      if (!checkHost(binding.hostRef, input.hostRef) || binding.applicationInstallationId !== expectedHost.applicationInstallationId
        || binding.allowedBaseId !== input.allowedBaseId || binding.configurationRevision !== input.configurationRevision
        || binding.relativePath !== input.relativePath || binding.accessMode !== input.accessMode
        || value.locationRevision !== input.expectedLocationRevision + 1 || binding.locationRevision !== String(value.locationRevision)
        || binding.rootPolicyRevision !== String(input.expectedRootPolicyRevision + 1)
        || value.executionLocation.rootPath !== binding.canonicalProjectRoot
        || binding.hostRef.kind === 'device' && binding.registration?.workerInstallationId !== expectedHost.applicationInstallationId
        || binding.hostRef.kind === 'main' && binding.registration !== null)
        invalid('Saved location acknowledgement does not match the submitted computer, root or revisions.')
      return result
    },
    onSuccess: result => {
      if (generation !== sessionGeneration()) return
      client.setQueryData<WorkspaceBoundLocationReadback>(boundLocationKeys.read(workspaceId, generation), previous => previous && previous.locationRevision > result.value.locationRevision ? previous : result.value)
      void client.invalidateQueries({ queryKey: boundLocationKeys.scope(workspaceId, generation) })
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
    },
  })
}
