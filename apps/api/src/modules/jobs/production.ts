import type pg from 'pg'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { createProductionSources } from '../sources/production.js'
import { createInstalledJobRuntimeHost, type InstalledRuntimeHostDependencies } from './installedRuntimeHost.js'
import { createJobRuntimeProfileService } from './runtimeProfileFactory.js'
import { PostgresJobDispatch } from './dispatch.js'
import { RemoteJobCarrierDispatch } from '../runs/remote/jobCarrierDispatch.js'
import type { RemoteJobExecutionHost } from '../runs/remote/jobExecutionHost.js'
import { CanonicalJobPreparationSources, CanonicalJobPreparationService, CanonicalJobPrivateRepositories } from './sourcePreparation.js'
import type { JobPreparationPort } from './ports.js'
import { JobPublicationAuthority } from './authority.js'
import { createCanonicalJobInputPorts } from '../files/jobInputs/factory.js'
import { createCanonicalJobArtifactPort } from '../files/jobs/factory.js'
import type { TrustedJobOutputReader } from '../files/jobs/port.js'
import { JobService } from './service.js'
import { JobWorkerService } from './worker.js'
import { projectJobReceiptLocked } from './receiptProjection.js'
import { publishWorkflowJobReceiptLocked } from './workflowReceiptPublication.js'
import { openRunGraphPublication } from '../run-graph/publication.js'
import { assertGraphTransaction } from '../run-graph/connection.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { createWorkflowJobComposition } from './workflowComposition.js'
import { JobApplicationBridge } from '../runs/remote/jobApplicationBridge.js'
import { join } from 'node:path'

export interface ProductionJobInfrastructure {
  installedConfiguration: InstalledRuntimeHostDependencies['configuration']
  reserveQualification?: InstalledRuntimeHostDependencies['reserve']
  localExecution?: RemoteJobExecutionHost
  sourceRemote?: Parameters<typeof createProductionSources>[0]['remote']
  privateRepositoryRemote?: ConstructorParameters<typeof CanonicalJobPrivateRepositories>[3]
  outputReader?: TrustedJobOutputReader
}
/** Concrete domain services are initialized after the original main identity.
 * Missing installer/host bytes remain unavailable, never a qualified default. */
export async function createProductionJobs(input: { pool: pg.Pool; commands: PostgresCommandCoordinator;
  locations: WorkspaceLocationService; mainId: string; runtimeRoot: string; storageRoot: string;
  endpoint(): DeviceEndpoint; infrastructure?: ProductionJobInfrastructure }) {
  const source = await createProductionSources({ ...input, dispatch: () => dispatch,
    ...(input.infrastructure?.sourceRemote ? { remote: input.infrastructure.sourceRemote } : {}) })
  const host = createInstalledJobRuntimeHost({ identity: input.pool,
    configuration: input.infrastructure?.installedConfiguration ?? null,
    reserve: async original => {
      if (!input.infrastructure?.reserveQualification) throw new DomainError('JOB_RUNTIME_OWNER_UNAVAILABLE', 'The installed runtime has no original admitted native and OCI owner.', 409)
      return input.infrastructure.reserveQualification(original)
    } })
  const profiles = createJobRuntimeProfileService({ pool: input.pool, commands: input.commands, sources: source.sources, host })
  const preparationPort: JobPreparationPort = {
    choices: (...args) => preparation.choices(...args), validate: (...args) => preparation.validate(...args),
    accept: (...args) => preparation.accept(...args), revalidateAccepted: (...args) => preparation.revalidateAccepted(...args),
    adoptFinalBinding: (...args) => preparation.adoptFinalBinding(...args),
  }
  const carrier = new RemoteJobCarrierDispatch(input.pool, { request: (deviceId, namespace, payload) => input.endpoint().request(deviceId, namespace, payload) }, input.infrastructure?.localExecution)
  const dispatch = new PostgresJobDispatch(input.pool, carrier, {
    revalidate: (sql, execution, principal) => preparationPort.revalidateAccepted(sql, principal, execution),
    authorizeControl: async (sql, execution) => {
      const target = execution.acceptedSpec.target
      await assertDeviceHostInstallation(sql, target.hostRef, target.hostRef.kind === 'main' ? target.hostRef.mainId : target.registration!.workerInstallationId)
    },
    async observe(sql, execution, receipt) {
      if (execution.workflow) {
        assertGraphTransaction(sql)
        const snapshot = await readAcceptedRepeatRunLocked(sql, execution.workflow.runId)
        const scope = { runId: snapshot.run.id, workspaceId: snapshot.run.workspaceId, workflowId: snapshot.run.workflowId,
          workflowVersionId: snapshot.version.id, executionSemanticsVersion: 3 as const }
        await publishWorkflowJobReceiptLocked(await openRunGraphPublication(sql, scope), execution, receipt, artifacts)
      } else await projectJobReceiptLocked(sql, execution, receipt, artifacts)
    },
  })
  const inputs = createCanonicalJobInputPorts({ pool: input.pool, storageRoot: input.storageRoot, runtime: dispatch,
    preparation: preparationPort, endpoint: { currentBinding: deviceId => input.endpoint().currentBinding(deviceId) }, receiptRoot: join(input.runtimeRoot, 'job-input-receipts') })
  const privateRepositories = new CanonicalJobPrivateRepositories(input.pool, source.sources, source.executions,
    input.infrastructure?.privateRepositoryRemote ?? { async preparePrivateRepository() { throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'The authenticated private repository host is unavailable.', 409) } })
  const preparation = new CanonicalJobPreparationService(new CanonicalJobPreparationSources(source.sources, profiles, privateRepositories,
    { validateDeclaredJobInputs: inputs.validateDeclaredJobInputs }, source.policies))
  const publication = new JobPublicationAuthority(dispatch, preparation)
  const artifacts = createCanonicalJobArtifactPort({ pool: input.pool, storageRoot: input.storageRoot, authority: publication,
    reader: input.infrastructure?.outputReader ?? { async open() { throw new DomainError('JOB_OUTPUT_HOST_UNAVAILABLE', 'The original verified Job output byte source is unavailable.', 409) } } })
  const jobs = new JobService(input.pool, input.commands, { preparation, dispatch, artifacts })
  const workers = new JobWorkerService(input.pool, { require: dispatch.require.bind(dispatch),
    verifyPublication: (sql, execution) => artifacts.verifyRequiredOutputs(sql, execution) })
  const application = new JobApplicationBridge(input.pool, dispatch, workers, publication)
  const workflow = createWorkflowJobComposition({ jobs, dispatch, outputs: artifacts })
  return { ...source, jobs, profiles, dispatch, artifacts, inputs, application, workflow, host,
    async close() { await dispatch.close() } }
}
