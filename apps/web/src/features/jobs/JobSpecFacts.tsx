import type { JobDefinitionSpec, AcceptedJobSpec } from '@graphql/contracts/jobs'
import { CodeBlock } from '../../shared/ui/nocturne'

export function JobSpecFacts({ spec }: { spec: JobDefinitionSpec | AcceptedJobSpec }) {
  const { target, policy } = spec
  return <div className="job-spec">
    <h3>Exact command</h3><CodeBlock code={JSON.stringify(spec.argv)} language="json" />
    <dl className="job-facts">
      <dt>Computer</dt><dd>{target.labelAtAcceptance ?? (target.hostRef.kind === 'device' ? target.hostRef.deviceId : 'Main computer')}</dd>
      <dt>Validated root</dt><dd>{target.destination.canonicalProjectRoot}</dd>
      <dt>Working directory</dt><dd>{spec.relativeCwd ?? '(materialized repository root)'}</dd>
      <dt>Source commit</dt><dd>{spec.source.commit}</dd>
      <dt>Network</dt><dd>{policy.network}</dd>
      <dt>Execution timeout</dt><dd>{policy.executionTimeoutMs} ms</dd>
      <dt>Inputs</dt><dd>{spec.inputs.length === 0 ? 'None' : spec.inputs.map(input => `${input.path} / ${input.fileId} / ${input.revisionId} / ${input.sha256} / ${input.byteSize} bytes`).join('\n')}</dd>
      <dt>Outputs</dt><dd>{spec.outputs.length === 0 ? 'None' : spec.outputs.map(output => `${output.path} (${output.required ? 'required' : 'optional'})`).join('\n')}</dd>
    </dl>
    <details><summary>Identities, limits and digests</summary>
      <dl className="job-facts">
        <dt>Host identity</dt><dd>{JSON.stringify(target.hostRef)}</dd>
        <dt>Root identity</dt><dd>{target.destination.directoryIdentityHash}</dd>
        <dt>Root binding revision</dt><dd>{target.destination.rootPolicyRevision} / location {target.destination.locationRevision}</dd>
        <dt>Source snapshot</dt><dd>{spec.source.snapshotId} · {spec.source.manifestDigest}</dd>
        <dt>Materialization</dt><dd>{'definitionVersionId' in spec ? spec.source.materializationId : 'Pending preparation'} · {'definitionVersionId' in spec ? spec.source.materializationDigest : 'Pending preparation'}</dd>
        <dt>Isolation policy</dt><dd>{policy.isolationPolicyId} · revision {policy.isolationPolicyRevision}</dd>
        <dt>Image / toolchain</dt><dd>{policy.imageDigest} / {policy.toolchainDigest}</dd>
        <dt>Timeouts</dt><dd>Queue {policy.queueTimeoutMs} ms · preparation {policy.preparationTimeoutMs} ms · execution {policy.executionTimeoutMs} ms</dd>
        <dt>Log bounds</dt><dd>{policy.maxLogBytes} bytes · overflow {policy.logOverflow} · retention {policy.retentionSeconds} s</dd>
      </dl>
    </details>
  </div>
}
