import { describe, expect, it } from 'vitest'
import { ExecutableWorkflowV3Schema, WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { toolFailure } from '../src/mcp/shared/results.js'
import { remoteReviewerPlacementFixture } from './helpers/remoteReviewerPlacement.js'

describe('designated Orchestrator placement', () => {
  it('keeps remote saved versions readable but rejects executable reviewer placement', () => {
    const { remote } = remoteReviewerPlacementFixture()
    expect(WorkflowVersionV3Schema.parse(remote.version)).toEqual(remote.version)
    const result = ExecutableWorkflowV3Schema.safeParse({
      version: remote.version, configurations: remote.configurations,
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Remote reviewer placement was admitted')
    expect(result.error.issues).toHaveLength(1)
    expect(result.error.issues[0]).toMatchObject({
      path: ['version', 'definition', 'nodes', 0, 'placement'],
      message: expect.stringContaining('REMOTE_REVIEWER_UNSUPPORTED'),
    })
    const failure = toolFailure(result.error)
    expect(failure.isError).toBe(true)
    expect(failure.structuredContent).toBeUndefined()
    expect(JSON.stringify(failure.content)).toContain('REMOTE_REVIEWER_UNSUPPORTED')
    expect(JSON.stringify(failure.content)).toContain('INVALID_REQUEST')
    expect(JSON.stringify(failure.content)).not.toContain(remote.version.id)
  })

  it('supports a Main Orchestrator reviewing a remotely placed requester', () => {
    const { remote } = remoteReviewerPlacementFixture()
    const reviewer = remote.version.definition.nodes[0]!
    remote.version.definition.nodes[1]!.placement = reviewer.placement!
    delete reviewer.placement
    expect(ExecutableWorkflowV3Schema.parse({
      version: remote.version, configurations: remote.configurations,
    }).version).toEqual(remote.version)
  })

  it('supports a Main placement for the designated Orchestrator', () => {
    const { remote } = remoteReviewerPlacementFixture()
    const placement = remote.version.definition.nodes[0]!.placement!
    placement.hostRef = { kind: 'main', mainId: placement.hostRef.mainId }
    expect(ExecutableWorkflowV3Schema.parse({
      version: remote.version, configurations: remote.configurations,
    }).version).toEqual(remote.version)
  })
})
