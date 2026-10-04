import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  TelemetrySelectorResultSchema, TelemetrySelectorTargetSchema, telemetryCanonical,
  type TelemetryHost, type TelemetryOwner, type TelemetrySelectorResult, type TelemetrySelectorService,
  type TelemetrySelectorTarget,
} from '@foreman-code/contracts/resource-telemetry'
import { DomainError } from '../../errors.js'
import type { ResourceTelemetryService } from '../ingestion/service.js'
import type { TelemetryDenialAudit } from './adapters.js'

export const RESOURCE_TELEMETRY_SELECTOR_ROUTE = '/api/management/resource-telemetry/selector' as const
export const RESOURCE_TELEMETRY_SELECTOR_TOOL = 'resource_telemetry_selector_get' as const
export type OwnedTelemetryTarget = Extract<TelemetrySelectorTarget, { scope: 'owned' }>
/** Existing accepted ownership/lease facts; collector generation belongs to the authenticated handshake. */
export interface TelemetryOwnedTargetFacts {
  owner: TelemetryOwner
  attributionRef: string
  attributionRevision: string
  host: Omit<TelemetryHost, 'collectorGeneration'>
}
export type TelemetryOwnedTargetResolution = { kind: 'owned'; facts: TelemetryOwnedTargetFacts }
  | { kind: 'denied' } | { kind: 'unavailable' }
/** Reuses existing role-specific scoped authority before retrieving private ownership facts. */
export interface TelemetryTargetAuthority {
  allowTarget(principal: ManagementPrincipal, target: TelemetrySelectorTarget, signal: AbortSignal): Promise<boolean>
  resolveOwned(principal: ManagementPrincipal, target: OwnedTelemetryTarget, signal: AbortSignal): Promise<TelemetryOwnedTargetResolution>
}
export class ResourceTelemetrySelectors implements TelemetrySelectorService<ManagementPrincipal> {
  constructor(private readonly service: ResourceTelemetryService, private readonly authority: TelemetryTargetAuthority) {}
  resolve(principal: ManagementPrincipal, target: TelemetrySelectorTarget, signal: AbortSignal): Promise<TelemetrySelectorResult> {
    return this.service.resolveSelector(principal, target, signal, this.authority)
  }
}
/** HTTP and MCP use the same bounded input, live authorization and non-disclosing result. */
export async function resolveTelemetrySelector(service: TelemetrySelectorService<ManagementPrincipal>, principal: ManagementPrincipal,
  input: unknown, signal: AbortSignal, source: 'http' | 'mcp', audit: TelemetryDenialAudit): Promise<TelemetrySelectorResult> {
  const parsed = TelemetrySelectorTargetSchema.safeParse(input)
  if (!parsed.success) throw new DomainError('INVALID_REQUEST', 'The telemetry target does not match its shared contract.', 400)
  const result = TelemetrySelectorResultSchema.parse(await service.resolve(principal, parsed.data, signal))
  if (result.kind === 'denied') await audit.record(principal.id, source, `resource-telemetry/target:${telemetryCanonical(parsed.data)}`)
  return result
}
