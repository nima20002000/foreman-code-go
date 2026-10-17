import { httpRoutes, type HttpRoute } from '../../coverage/http-routes.js'

/**
 * These production mounts were reviewed against registerOperatorHttpSecurity at the
 * pinned baseline. Their JSON handlers run after its invalid-bearer preHandler.
 * This is an explicit inventory-source allowlist, never a runtime source-text check.
 */
const protectedRouteSources = new Set([
  'apps/api/src/modules/devices/management.ts',
  'apps/api/src/modules/devices/trustedConnectionManagement.ts',
  'apps/api/src/modules/harnesses/registryManagement.ts',
  'apps/api/src/modules/placement/transports.ts',
  'apps/api/src/modules/workspace-roots/transports.ts',
  'apps/api/src/routes/agentChat.ts',
  'apps/api/src/routes/bugReports.ts',
  'apps/api/src/routes/buildComputers.ts',
  'apps/api/src/routes/claudePlugins.ts',
  'apps/api/src/routes/computerAccounts.ts',
  'apps/api/src/routes/computerActivity.ts',
  'apps/api/src/routes/computerMaintenance.ts',
  'apps/api/src/routes/computerSync.ts',
  'apps/api/src/routes/currentVersionReads.ts',
  'apps/api/src/routes/currentWorkflow.ts',
  'apps/api/src/routes/fileReferences.ts',
  'apps/api/src/routes/fileRetention.ts',
  'apps/api/src/routes/harnessSettings.ts',
  'apps/api/src/routes/hostCi.ts',
  'apps/api/src/routes/jobRuntimeProfiles.ts',
  'apps/api/src/routes/jobs.ts',
  'apps/api/src/routes/management.ts',
  'apps/api/src/routes/mcpDetection.ts',
  'apps/api/src/routes/operatorChat.ts',
  'apps/api/src/routes/product.ts',
  'apps/api/src/routes/promptSettings.ts',
  'apps/api/src/routes/providerAccounts.ts',
  'apps/api/src/routes/runGraph.ts',
  'apps/api/src/routes/runHistory.ts',
  'apps/api/src/routes/runInspection.ts',
  'apps/api/src/routes/runSubagents.ts',
  'apps/api/src/routes/selectedRunChat.ts',
  'apps/api/src/routes/skills.ts',
  'apps/api/src/routes/sources.ts',
  'apps/api/src/routes/userInteractions.ts',
  'apps/api/src/routes/workflowSchedules.ts',
  'apps/api/src/routes/workspaceDefaults.ts',
  'apps/api/src/routes/workspaceRepository.ts',
])

function protectedByOperatorPreHandler(route: HttpRoute): boolean {
  if (route.transport !== 'http') return false
  const source = route.provenance.slice(0, route.provenance.lastIndexOf(':'))
  // Raw upload PUT has an earlier content-type onRequest hook; its dedicated
  // cases must supply actual bytes before asserting its authentication result.
  if (source === 'apps/api/src/routes/files.ts') return route.method !== 'PUT'
  return protectedRouteSources.has(source)
}

/**
 * Separate worker artifact authenticators, optional telemetry mounts, public
 * bootstrap, SSE, web, and runtime listeners retain their own inventory gaps.
 * Every selected entry below is requested by the associated lane scenario.
 */
export const protectedHttpRoutes = httpRoutes.filter(protectedByOperatorPreHandler)
