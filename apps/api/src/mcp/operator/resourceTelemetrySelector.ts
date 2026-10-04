import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { TelemetrySelectorTargetSchema, type TelemetrySelectorService } from '@foreman-code/contracts/resource-telemetry'
import { toolFailure } from '../shared/results.js'
import { RESOURCE_TELEMETRY_SELECTOR_TOOL, resolveTelemetrySelector } from '../../modules/resource-telemetry/readback/selector.js'
import type { TelemetryDenialAudit } from '../../modules/resource-telemetry/readback/adapters.js'

export function registerResourceTelemetrySelectorTools(server: McpServer, principal: ManagementPrincipal,
  selectors: TelemetrySelectorService<ManagementPrincipal>, audit: TelemetryDenialAudit): void {
  server.registerTool(RESOURCE_TELEMETRY_SELECTOR_TOOL, {
    description: 'Resolve one authorized ResourceTelemetry selector from an exact public computer, Run execution, CI attempt, or conversation reference. The server supplies authenticated host and collector generations from existing live ownership; this never creates an owner, starts collection or execution, or grants computer access from an owned scope. Denied and unavailable results expose no identities, owners, or metric values.',
    inputSchema: TelemetrySelectorTargetSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => {
    try {
      const result = await resolveTelemetrySelector(selectors, principal, input, extra.mcpReq.signal, 'mcp', audit)
      return { ...(result.kind === 'denied' ? { isError: true } : {}),
        content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) { return toolFailure(error) }
  })
}
