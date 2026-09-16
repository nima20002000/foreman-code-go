import type { ApiConfig } from './config.js'
import { buildApp } from './app.js'
import type { CheckpointStore } from './infrastructure/checkpoints.js'
import type { createDatabase } from './infrastructure/database.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { WorkerCredentialService } from './modules/access/workerCredentials.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { DomainError } from './modules/errors.js'
import { GraphDraftService } from './modules/graph-drafts/service.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { CodexAppServerSessionManager } from './modules/harnesses/codexAppServer.js'
import { codexMcpInspectorAdapter } from './modules/harnesses/codexMcpInspectorAdapter.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from './modules/harnesses/mcpDetection.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './modules/harnesses/opencodeServer.js'
import { openCodeMcpInspectorAdapter } from './modules/harnesses/opencodeMcpInspectorAdapter.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { LocalHarnessResolver } from './modules/harnesses/resolver.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from './modules/interactions/execution.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { PostgresInteractionRepository } from './modules/interactions/postgres.js'
import { ExecutionScopedNativeSessionManagerResolver } from './modules/interactions/runtimePorts.js'
import { InteractionService } from './modules/interactions/service.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { RunManagementService } from './modules/runs/management.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { PostgresSettingsRepository } from './modules/settings/postgres.js'
import { WorkflowManagementService } from './modules/workflows/management.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { AgentManagementService } from './modules/workspaces/agents.js'
import { WorkspaceLocationService } from './modules/workspaces/location.js'
import { WorkspaceManagementService } from './modules/workspaces/management.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'

function inspectorFor(manager: NativeHarnessSessionManager) {
  if (manager instanceof CodexAppServerSessionManager) return codexMcpInspectorAdapter(manager)
  if (manager instanceof OpenCodeNativeSessionManager) return openCodeMcpInspectorAdapter(manager)
  throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The native manager has no production MCP inspector.', 503)
}

/** The startup composition is shared with regression tests; infrastructure owns its lifecycle. */
export function buildProductionApp(
  config: ApiConfig,
  database: ReturnType<typeof createDatabase>,
  checkpoints: CheckpointStore,
  logger = true,
) {
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const repository = new PostgresInteractionRepository(database.pool)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot)
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows, locations)
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = new PostgresSettingsRepository(database.pool)
  const harnesses = new LocalHarnessResolver(config.harnesses.codexBinary, config.harnesses.openCodeBinary)
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  const appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp/tools`
  const managers = new ExecutionScopedNativeSessionManagerResolver((context) => {
    const configuration = context.configuration.harness
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    if (configuration.harness === 'codex') return new CodexAppServerSessionManager(config.harnesses.codexBinary)
    return new OpenCodeNativeSessionManager({
      server: new ManagedOpenCodeServer({
        binary: config.harnesses.openCodeBinary,
        workingDirectory: context.workingDirectory,
        ownerAgentId: context.agentId,
        ...(configuration.advanced ? { advancedConfiguration: configuration.advanced } : {}),
      }),
      ownerAgentId: context.agentId,
      expectedAppMcpEndpoint: appMcpEndpoint,
    })
  })
  const credentials = new WorkerCredentialService(database.pool, access)
  const launchCredentials: ExecutionCredentialProvider = {
    async prepare(input) {
      const execution = await runs.getExecution(input.executionId)
      if (!execution || execution.workingDirectory !== input.workingDirectory) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight must use the accepted execution directory.', 409)
      }
      const configuration = await runs.getExecutionConfiguration(execution.agentConfigurationVersionId)
      const run = await runs.get(execution.runId)
      if (!configuration || configuration.id !== execution.agentConfigurationVersionId
        || configuration.agentId !== execution.agentId || configuration.harness.harness !== input.harness
        || !run?.executionLocation || run.executionLocation.runnerId !== 'runner-local') {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the pinned local execution identity.', 409)
      }
      const context = {
        executionId: execution.id, agentId: execution.agentId, harness: input.harness,
        workingDirectory: input.workingDirectory, configuration,
      }
      const { manager } = managers.resolve(context)
      const detection = new McpDetectionService(inspectorFor(manager), appMcpEndpoint)
      const launch = new WorkerLaunchCredentialService(detection, credentials, run.executionLocation.runnerId)
      try {
        return await launch.prepare(input)
      } catch (error) {
        // A model-free OpenCode preflight may have started its owned server.
        // Never retain that unauthenticated process after rejected issuance.
        if (manager instanceof OpenCodeNativeSessionManager) await manager.dispose().catch(() => undefined)
        managers.release(context)
        throw error
      }
    },
    revoke: (credential) => credentials.revoke(credential),
    revokeForExecution: (executionId) => credentials.revokeForExecution(executionId),
  }
  const approvals = new ApprovalExecutionCoordinator(
    runs, repository, budgets, managers, config.harnesses.timeoutMs, launchCredentials,
  )
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, harnesses, checkpoints.saver, config.harnesses.workspaceRoot,
    config.harnesses.timeoutMs, locations, launchCredentials, approvals, repository,
  )
  const interactions = new InteractionService(
    repository, budgets, approvals, (interaction) => engine.resumeInteraction(interaction),
  )
  const operatorServices = {
    workspaces: new WorkspaceManagementService(database.pool, commands, locations),
    locations,
    workflows: new WorkflowManagementService(database.pool, commands),
    agents: new AgentManagementService(database.pool),
    drafts: new GraphDraftService(database.pool, commands),
    harnesses: new HarnessCatalogService(harnesses, settings, commands, config.harnesses.workspaceRoot),
    runs: new RunManagementService(database.pool, commands, runs, engine, locations),
    commands,
    interactions: new OperatorInteractionService(interactions, repository),
  }
  const detection = new McpDetectionService({
    async inspect(input) {
      if (input.runnerId !== 'runner-local') {
        throw new DomainError('RUNNER_UNSUPPORTED', 'This API can inspect only its local runner.', 409)
      }
      if (input.harness === 'codex') {
        return codexMcpInspectorAdapter(new CodexAppServerSessionManager(config.harnesses.codexBinary)).inspect(input)
      }
      // Workspace diagnostics are model-free: no durable session or credential
      // is created. Execution preflight above uses the pinned Agent manager.
      const manager = new OpenCodeNativeSessionManager({
        server: new ManagedOpenCodeServer({
          binary: config.harnesses.openCodeBinary, workingDirectory: input.workingDirectory,
          ownerAgentId: 'mcp-inspection',
        }),
        ownerAgentId: 'mcp-inspection', expectedAppMcpEndpoint: appMcpEndpoint,
      })
      try {
        return await openCodeMcpInspectorAdapter(manager).inspect(input)
      } finally {
        await manager.dispose()
      }
    },
  }, appMcpEndpoint)
  const app = buildApp({
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    product: { workspaces, workflows, runs, settings, engine, interactions },
    operator: { access, services: operatorServices },
    appMcp: { access, interactions: new PostgresAppInteractionService(database.pool, repository, commands, interactions) },
    mcpDetection: { pool: database.pool, service: detection },
    logger,
  })
  return { app, engine }
}
