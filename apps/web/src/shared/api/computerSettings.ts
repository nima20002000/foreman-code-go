import { z } from 'zod'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { DevicePairingGrantInputSchema, DevicePairingGrantResultSchema, DeviceRevokeInputSchema, DeviceRegistrationSchema, DeviceListResultSchema, MainDeviceIdentityPublicSchema } from '@graphql/contracts/device-identity'
import { HostHarnessInstanceCheckInputSchema, HostHarnessInstanceCheckResultSchema, type HostHarnessInstanceCheckInput, HostHarnessOverrideListSchema, HostHarnessOverrideListInputSchema, HostHarnessOverrideSaveSchema, HostHarnessOverrideSaveResultSchema, type HostHarnessOverrideListInput, type HostHarnessOverrideSave, HarnessHostReferenceSchema, HarnessRegistryReadbackSchema } from '@graphql/contracts/harness-registry'
import { DeviceSetupApproveInputSchema, DeviceSetupApproveResultSchema, DeviceSetupOptionsSchema } from '@graphql/contracts/device-setup'
import type { CanonicalMachineReference } from '@graphql/contracts/device-identity'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const computerSettingsKeys = {
  root: ['workbench', 'computer-settings'] as const,
  main: () => [...computerSettingsKeys.root, sessionGeneration(), 'main'] as const,
  devices: (mainId: string) => [...computerSettingsKeys.root, sessionGeneration(), mainId, 'devices'] as const,
  setupOptions: (mainId: string) => [...computerSettingsKeys.root, sessionGeneration(), mainId, 'setup-options'] as const,
  inventory: (host: CanonicalMachineReference, applicationInstallationId?: string) => [...computerSettingsKeys.root, sessionGeneration(), host, applicationInstallationId ?? null, 'harness-registry'] as const,
}
export function useSelectedMainQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: computerSettingsKeys.main(), enabled: !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request('/api/devices/main', MainDeviceIdentityPublicSchema, { signal }) })
}
export function useRegisteredComputersQuery(mainId: string | undefined) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: computerSettingsKeys.devices(mainId ?? ''), refetchInterval: 5_000, enabled: Boolean(mainId) && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request('/api/devices', DeviceListResultSchema, { signal })
      if (result.devices.some(value => value.mainId !== mainId)) throw new Error('Computer readback belongs to a different main installation.')
      return result
    } })
}
export function useHostHarnessRegistryQuery(host: CanonicalMachineReference | undefined, applicationInstallationId?: string) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: host ? computerSettingsKeys.inventory(host, applicationInstallationId) : [...computerSettingsKeys.root, sessionGeneration(), 'unselected'],
    enabled: Boolean(host) && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      const value = HarnessHostReferenceSchema.parse(host)
      const query = new URLSearchParams({ kind: value.kind, mainId: value.mainId, ...(value.kind === 'device' ? { deviceId: value.deviceId } : {}) })
      const result = await apiClient.request(`/api/management/harnesses/registry?${query}`, HarnessRegistryReadbackSchema, { signal })
      if (result.installations.some(installation => !sameComputer(installation.hostRef, value))
        || result.hostMetadata && (!sameComputer(result.hostMetadata.hostRef, value) || applicationInstallationId && result.hostMetadata.applicationInstallationId !== applicationInstallationId))
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Harness inventory belongs to another computer.' })
      return result
    } })
}

export function useCreateComputerPairingGrant(mainId: string) {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), mainId, 'pairing-grant'],
    mutationFn: async (input: z.input<typeof DevicePairingGrantInputSchema>) => {
      const result = await apiClient.request('/api/devices/pairing-grants', DevicePairingGrantResultSchema,
        { method: 'POST', body: DevicePairingGrantInputSchema.parse(input) })
      if (result.registration.mainId !== mainId) throw new Error('Pairing grant belongs to a different main.')
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
  })
}
/** The device endpoint is server-configured; it is never derived from the browser address. */
export function useComputerSetupOptionsQuery(mainId: string) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: computerSettingsKeys.setupOptions(mainId), enabled: !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request('/api/devices/setup-options', DeviceSetupOptionsSchema, { signal }) })
}
/** The result carries a private enrollment code; keep it in the mutation result only. */
export function useApproveComputerSetup(mainId: string) {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), mainId, 'setup-code'],
    mutationFn: async (input: z.input<typeof DeviceSetupApproveInputSchema>) => {
      const result = await apiClient.request('/api/devices/setup-codes', DeviceSetupApproveResultSchema,
        { method: 'POST', body: DeviceSetupApproveInputSchema.parse(input) })
      if (result.registration.mainId !== mainId) throw new Error('Computer approval belongs to a different main.')
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
  })
}
export function useRevokeComputer() {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), 'revoke'],
    mutationFn: async (input: z.input<typeof DeviceRevokeInputSchema>) => {
      const result = await apiClient.request('/api/devices/revoke', DeviceRegistrationSchema,
        { method: 'POST', body: DeviceRevokeInputSchema.parse(input) })
      if (result.deviceId !== input.deviceId || result.status !== 'revoked')
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Revocation was not confirmed for this worker.' })
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
  })
}

export function useHostHarnessOverridesQuery(input: HostHarnessOverrideListInput) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: [...computerSettingsKeys.root, sessionGeneration(), 'overrides', input], enabled: !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request('/api/management/harness-instances/read', HostHarnessOverrideListSchema,
        { method: 'POST', body: HostHarnessOverrideListInputSchema.parse(input), signal })
      if (result.overrides.some(value => !sameComputer(value.target.hostRef, input.hostRef) || value.target.applicationInstallationId !== input.applicationInstallationId))
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Host settings readback belongs to another computer or application installation.' })
      return result
    } })
}
export function useSaveHostHarnessOverride() {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), 'save-override'],
    mutationFn: async (input: HostHarnessOverrideSave) => {
      const result = await apiClient.request('/api/management/harness-instances/save', HostHarnessOverrideSaveResultSchema,
        { method: 'POST', body: HostHarnessOverrideSaveSchema.parse(input) })
      if (result.value.instanceId !== input.instanceId || !sameComputer(result.value.target.hostRef, input.target.hostRef)
        || result.value.target.applicationInstallationId !== input.target.applicationInstallationId
        || result.value.target.harnessInstallationId !== input.target.harnessInstallationId
        || result.value.target.installationFingerprint !== input.target.installationFingerprint)
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Saved host settings belong to another installation or instance.' })
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
    onError: error => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: computerSettingsKeys.root }) },
  })
}

function sameComputer(left: CanonicalMachineReference, right: CanonicalMachineReference) {
  return left.kind === right.kind && left.mainId === right.mainId && (left.kind === 'main' || right.kind === 'device' && left.deviceId === right.deviceId)
}

export function useCheckHostHarnessInstance() {
  const client = useQueryClient()
  return useMutation({ mutationKey: [...computerSettingsKeys.root, sessionGeneration(), 'check-host-profile'],
    mutationFn: async (input: HostHarnessInstanceCheckInput) => {
      const result = await apiClient.request('/api/management/harness-instances/check', HostHarnessInstanceCheckResultSchema,
        { method: 'POST', body: HostHarnessInstanceCheckInputSchema.parse(input) })
      if (result.value.instanceId !== input.instanceId || result.value.revision !== input.expectedRevision
        || !sameComputer(result.value.target.hostRef, input.target.hostRef)
        || result.value.target.applicationInstallationId !== input.target.applicationInstallationId
        || result.value.target.harnessInstallationId !== input.target.harnessInstallationId
        || result.value.target.installationFingerprint !== input.target.installationFingerprint
        || !sameComputer(result.proof.target.hostRef, input.target.hostRef)
        || result.proof.target.applicationInstallationId !== input.target.applicationInstallationId
        || result.proof.target.harnessInstallationId !== input.target.harnessInstallationId
        || result.proof.target.installationFingerprint !== input.target.installationFingerprint
        || result.proof.instanceRevision !== result.value.instanceRevision
        || result.proof.configurationFingerprint !== result.value.configurationFingerprint
        || result.proof.driverId !== result.value.driverId)
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Profile check evidence does not match the submitted installation and saved instance.' })
      return result
    },
    onSuccess: () => client.invalidateQueries({ queryKey: computerSettingsKeys.root }),
    onError: error => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: computerSettingsKeys.root }) },
  })
}
