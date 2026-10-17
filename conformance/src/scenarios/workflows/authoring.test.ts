import { describe, expect, it } from 'vitest'
import { AgentCreateInputSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture, WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { fixtureAgentName } from './authoring.js'

const fixture = makeCurrentWorkflowFixture('authoring-name-contract', 'single')
const original = fixture.version.definition.nodes[0]!
const configuration = fixture.configurations[0]!
const nodeSchema = WorkflowDefinitionV3Schema.shape.nodes.element

function publicAgentInput(node: typeof original) {
  return AgentCreateInputSchema.parse({ workspaceId: fixture.version.workspaceId,
    commandId: 'authoring-name-contract', agentId: node.agentId, name: fixtureAgentName(node),
    productRole: configuration.productRole, configuration: configuration.harness,
    prompt: configuration.prompt, assignedSkills: configuration.assignedSkills })
}

describe('shared workflow fixture names at public Agent authoring', () => {
  it('preserves a named node when its optional label differs', () => {
    const node = nodeSchema.parse({ ...original, label: 'Visible Board label' })
    if (node.kind === 'job') throw new Error('The generated Agent fixture changed kind.')
    expect(publicAgentInput(node)).toEqual(publicAgentInput(original))
    expect(publicAgentInput(node).name).toBe('Worker 0')
  })

  it('authors the accepted label of a valid label-only shared Agent node', () => {
    const unnamed = { ...original }
    delete unnamed.name
    const node = nodeSchema.parse({ ...unnamed, label: 'Label-only Agent' })
    if (node.kind === 'job') throw new Error('The generated Agent fixture changed kind.')
    const created = publicAgentInput(node)
    expect(created).toEqual({ ...publicAgentInput(original), name: 'Label-only Agent' })
    expect(created.agentId).toBe(original.agentId)
    expect(node).not.toHaveProperty('name')
  })

  it('rejects an unnamed invalid fixture instead of inventing a public Agent identity', () => {
    const unnamed = { ...original }
    delete unnamed.name
    delete unnamed.label
    expect(nodeSchema.safeParse(unnamed).success).toBe(false)
    expect(() => publicAgentInput(unnamed)).toThrow('The shared Agent fixture node must have a name or label.')
  })
})
