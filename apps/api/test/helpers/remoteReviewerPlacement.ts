import { randomUUID } from 'node:crypto'
import { SavedNodePlacementSchema } from '@graphql/contracts/node-placement'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'

export function remoteReviewerPlacementFixture() {
  const baseline = makeCurrentWorkflowFixture(randomUUID(), 'approval')
  const remote = structuredClone(baseline)
  remote.version.definition.nodes[0]!.placement = SavedNodePlacementSchema.parse({
    schemaVersion: 1,
    hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() },
    rootPolicyId: 'project-root', rootPolicyRevision: '1', locationRevision: '1',
    projectRoot: '/project', cwdPolicy: 'project-root', relativeCwd: '',
    instanceId: 'codex-instance', instanceRevision: '1', harnessInstallationId: 'codex-installation',
  })
  return { baseline, remote }
}
