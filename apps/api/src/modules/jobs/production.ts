import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { lstat } from 'node:fs/promises'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { reserveInstalledJobQualification } from './installedRuntimeQualification.js'
import { createJobQualificationCarrier } from './qualificationCarrier.js'
import { SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import type { SourceManifest } from '@graphql/contracts/source-materialization'
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
  endpoint(): DeviceEndpoint; infrastructure?: ProductionJobInfrastructure;
  activeNativeSession?: NonNullable<Parameters<typeof createProductionSources>[0]['activeNativeSession']>;
  captureNativeSession?: NonNullable<Parameters<typeof createProductionSources>[0]['captureNativeSession']>; nativeRegistry?: NativeProcessRegistry }) {
  const source = await createProductionSources({ ...input, dispatch: () => dispatch,
    ...(input.infrastructure?.sourceRemote ? { remote: input.infrastructure.sourceRemote } : {}) })
  const configurationPath = join(input.runtimeRoot, 'job-runtime.json')
  const configured = await lstat(configurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  let qualificationJournal: Promise<RemoteOperationJournal> | undefined
  const localHost = createInstalledJobRuntimeHost({ identity: input.pool,
    configuration: input.infrastructure?.installedConfiguration ?? (configured ? { path: configurationPath, ownerUid: process.getuid!() } : null),
    currentConnection: async (_sql, profile) => profile.root.selection.hostRef.kind === 'device'
      ? input.endpoint().currentBinding(profile.root.selection.hostRef.deviceId) ?? null : null,
    reserve: async original => {
      if (input.infrastructure?.reserveQualification) return input.infrastructure.reserveQualification(original)
      if (!input.nativeRegistry || original.nativeAdmission.hostRef.kind !== 'main') throw new DomainError('JOB_RUNTIME_OWNER_UNAVAILABLE', 'The actual original local diagnostic native owner is unavailable.', 409)
      qualificationJournal ??= RemoteOperationJournal.open(join(input.runtimeRoot, 'job-runtime-operations.json'))
      const admission = original.nativeAdmission
      return reserveInstalledJobQualification({ candidate: original.candidate, admission, journal: await qualificationJournal,
        registry: input.nativeRegistry, signal: original.signal,
        host: { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: input.mainId, bootId: original.candidate.fingerprint.bootId, connection: null },
        assertAdmission: async supplied => { if (!sameWorkflowValue(supplied, admission)) throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original local diagnostic admission changed.', 409); await original.assertAdmission() },
        authority: {
          readApproval: async id => { if (id !== admission.approvalId) return null; await original.assertAdmission(); return { status: 'approved', fingerprint: admission.fingerprintDigest, expiresAt: admission.expiresAt } },
          assertCurrent: async candidate => { if (!sameWorkflowValue(candidate, original.candidate)) throw new DomainError('JOB_RUNTIME_NATIVE_ADMISSION_CONFLICT', 'The original local diagnostic candidate changed.', 409); await original.assertAdmission() },
          async reserve() { throw new DomainError('JOB_RUNTIME_OWNER_UNAVAILABLE', 'The original installed diagnostic owner controls reservation.', 409) },
        },
      })
    } })
  const qualification = createJobQualificationCarrier({ pool: input.pool, sources: source.sources, endpoint: input.endpoint, local: localHost })
  const host = qualification.host
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
    input.infrastructure?.privateRepositoryRemote ?? { async preparePrivateRepository(principal, record) {
      const sql = await input.pool.connect()
      let manifest: SourceManifest
      try {
        await sql.query('begin')
        const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',
          [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
        const root = SourceRootRecordSchema.parse(row?.record)
        manifest = (await source.sources.resolveApprovedSource(sql, principal, record.receipt.binding.workspaceId, root.source)).manifest
        await sql.query('commit')
      } catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
      await source.sources.verifyPreparation({ principal, record })
      await source.executions.privateRepository(record, manifest)
    } })
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
  return { ...source, jobs, profiles, dispatch, artifacts, inputs, application, workflow, host, qualificationExtension: qualification.extension,
    async close() { await dispatch.close(); if (qualificationJournal) await (await qualificationJournal).close() } }
}
