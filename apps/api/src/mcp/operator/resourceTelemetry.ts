import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { TelemetrySelectorSchema, type TelemetryReadService } from '@foreman-code/contracts/resource-telemetry'
import { toolFailure } from '../shared/results.js'
import { readTelemetry, RESOURCE_TELEMETRY_READ_TOOL, type TelemetryDenialAudit } from '../../modules/resource-telemetry/readback/adapters.js'
/** Tool listing is discovery only: the shared service resolves the exact live grant on every call. */
export function registerResourceTelemetryTools(server: McpServer, principal: ManagementPrincipal,
  reads: TelemetryReadService<ManagementPrincipal>, audit: TelemetryDenialAudit): void {
  server.registerTool(RESOURCE_TELEMETRY_READ_TOOL, {
    description: 'Read ResourceTelemetry v1 for one exact computer or owned workflow/CI/conversation selector. Requires a live explicit whole-computer telemetry grant or the exact role-specific owned-scope grant; Agent/Run access never implies computer permission. Passive bounded CPU/RAM, plus free disk space on computer reads; freshness expires at six seconds; denied exposes no cached values. This never starts collectors, providers, processes or pairing.',
    inputSchema: TelemetrySelectorSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    try {
      const result = await readTelemetry(reads, principal, input, extra.mcpReq.signal, 'mcp', audit)
      return { ...(result.kind === 'denied' ? { isError: true } : {}),
      content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) { return toolFailure(error) }
  })
}
