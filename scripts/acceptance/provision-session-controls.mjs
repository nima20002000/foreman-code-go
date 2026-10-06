import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSessionControlMatrix } from './prepare-session-controls.mjs'
import { sessionControlProduct } from './session-control-product.mjs'
import { assertSessionControlDefaults } from './session-control-client.mjs'

function validateSubjects(input, contracts, profiles, placements, identity) {
  assert.deepEqual(identity, input.expectedIdentity, 'The reviewed fixture app identity changed.')
  assert.equal(input.subjects.length, 6, 'Provide one installation selection per harness and host.')
  const keys = new Set()
  const subjects = input.subjects.map(subject => {
    const configuration = contracts.HarnessConfigurationSchema.parse(subject.configuration)
    const hostRef = profiles.HarnessHostReferenceSchema.parse(subject.hostRef)
    assert.equal(hostRef.mainId, identity.installationId, 'The installation belongs to another Main.')
    if (configuration.harness === 'claude') {
      assert.ok(['haiku', 'claude-haiku-4-5-20251001'].includes(configuration.model), 'Use explicit Haiku.')
    }
    if (configuration.harness === 'codex') assert.equal(configuration.reasoningEffort, 'medium')
    assert.ok(subject.parentPath, 'Provide the disposable fixture workspace parent.')
    if (hostRef.kind === 'device') {
      assert.ok(subject.placement, 'A Worker node requires its approved placement; no location is inferred.')
    }
    const placement = subject.placement && placements.SavedNodePlacementSchema.omit({
      instanceId: true, instanceRevision: true, harnessInstallationId: true,
    }).parse(subject.placement)
    if (placement) assert.deepEqual(placement.hostRef, hostRef, 'The node placement belongs to another host.')
    keys.add(`${configuration.harness}:${hostRef.kind}`)
    return { ...subject, configuration, hostRef, placement }
  })
  assert.equal(keys.size, 6, 'Installation selections must cover all six harness/host pairs.')
  const devices = new Set(subjects.filter(subject => subject.hostRef.kind === 'device').map(subject => subject.hostRef.deviceId))
  assert.equal(devices.size, 1, 'Use one exact paired Worker for all three harnesses.')
  return subjects
}

async function qualifyProfile(subject, { profiles, tool }) {
  const inventory = profiles.HarnessRegistryReadbackSchema.parse(await tool('harness_registry_get', subject.hostRef))
  assert.deepEqual(inventory.hostMetadata?.hostRef, subject.hostRef)
  if (subject.hostRef.kind === 'device') {
    assert.equal(inventory.hostMetadata.connection?.phase, 'ready', 'The selected Worker is not connected.')
  }
  const installation = inventory.installations.find(value => value.driverId === subject.configuration.harness)
  assert.ok(installation?.installed && installation.installationFingerprint, 'The selected native installation is unavailable.')
  assert.deepEqual(installation.hostRef, subject.hostRef, 'The installation readback belongs to another host.')
  const target = profiles.HostHarnessOverrideTargetSchema.parse({ hostRef: subject.hostRef,
    applicationInstallationId: inventory.hostMetadata.applicationInstallationId,
    harnessInstallationId: installation.harnessInstallationId,
    installationFingerprint: installation.installationFingerprint })
  const saved = profiles.HostHarnessOverrideSaveResultSchema.parse(await tool('harness_instance_save', {
    commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target,
    presetId: `local-default:${subject.configuration.harness}`, enabled: true, configuration: subject.configuration,
  })).value
  const profileCheckRequest = { instanceId: saved.instanceId, expectedRevision: saved.revision, target }
  const checked = profiles.HostHarnessInstanceCheckResultSchema.parse(await tool('harness_instance_check', {
    ...profileCheckRequest, commandId: randomUUID(),
  }))
  assert.deepEqual(checked.value.target, target)
  assert.equal(checked.value.instanceId, saved.instanceId)
  assert.deepEqual(checked.value.configuration, saved.configuration)
  assert.equal(checked.proof.instanceRevision, checked.value.instanceRevision)
  assert.deepEqual(checked.proof.target, target)
  assert.equal(checked.proof.configurationFingerprint, checked.value.configurationFingerprint)
  assert.equal(checked.proof.authenticated, true, 'The actual native profile is not authenticated.')
  assert.equal(checked.proof.compatible, true, 'The actual native profile is not compatible.')
  assert.equal(checked.proof.qualified, true, 'The actual native profile did not qualify.')
  const readback = profiles.HostHarnessOverrideListSchema.parse(await tool('harness_instances_list', {
    hostRef: subject.hostRef, applicationInstallationId: target.applicationInstallationId,
  })).overrides.find(value => value.instanceId === saved.instanceId)
  assert.deepEqual(readback, checked.value, 'Persisted profile readback differs from qualification.')
  return { profile: checked.value, profileCheckRequest }
}

async function saveNode(subject, profile, { contracts, management, workflows, tool }) {
  const name = `Session controls ${profile.driverId} ${subject.hostRef.kind}`
  const workspace = management.ManagedWorkspaceCommandResultSchema.parse(await tool('workspace_create', {
    commandId: randomUUID(), name, parentPath: subject.parentPath,
    description: 'Disposable native session controls acceptance.',
  })).value
  assert.equal(workspace.locationValidation.status, 'ready', 'The fixture workspace folder is unavailable.')
  const workspaceId = workspace.workspace.id
  const created = workflows.SavedManagedWorkflowCommandResultSchema.parse(await tool('workflow_create', {
    commandId: randomUUID(), workspaceId, name, executionSemanticsVersion: 3,
  })).value
  assert.equal(created.currentVersionId, null, 'The fixture workflow is not fresh.')
  const agentId = randomUUID()
  const workflowNodeId = randomUUID()
  const selector = { instanceId: profile.instanceId, instanceRevision: profile.instanceRevision, target: profile.target }
  const agent = contracts.AgentSchema.parse({ id: agentId, name, productRole: 'coder',
    harness: profile.driverId, model: profile.configuration.model, harnessConfiguration: profile.configuration,
    harnessProfileSelection: selector, prompt: { system: 'Follow the chat request. Preserve the accepted sandbox and tool policy.' },
    assignedSkills: [] })
  const graph = { ...created.workflow, entryNodeId: workflowNodeId, requiredAgentCount: 1, edges: [],
    nodes: [{ id: workflowNodeId, agentId, name, position: { x: 0, y: 0 }, initialPrompt: 'Follow the current chat request.',
      ...(subject.placement ? { placement: { ...subject.placement, instanceId: profile.instanceId,
        instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId } } : {}) }] }
  const draftId = randomUUID()
  await tool('workflow_edit_v3', workflows.CurrentEditStageInputSchema.parse({ action: 'stage_edits',
    commandId: randomUUID(), draftId, workspaceId, workflowId: graph.id, executionSemanticsVersion: 3,
    expectedRevision: created.revision, expectedWorkflowVersionId: null,
    expectedLocationRevision: workspace.locationRevision, expectedAgentConfigurationVersionIds: {}, graph,
    stagedAgents: [{ agent, baseRevision: null }] }))
  const staged = workflows.CurrentEditReadResultSchema.parse(await tool('workflow_edits_get_v3', {
    action: 'read_edits', workspaceId, workflowId: graph.id, draftId,
  })).intent
  assert.ok(staged && staged.state === 'staged' && staged.affected.length === 0, 'The fresh fixture has unsettled work.')
  await tool('workflow_edit_v3', { action: 'stop_and_save', workspaceId, workflowId: graph.id,
    draftId, intentId: staged.id, commandId: staged.advanceCommandId })
  const saved = workflows.CurrentWorkflowReadResultSchema.parse(await tool('workflow_saved_get_v3', {
    workspaceId, workflowId: graph.id,
  })).version
  assert.deepEqual(saved.definition.nodes.map(node => [node.id, node.agentId]), [[workflowNodeId, agentId]])
  const version = management.AgentVersionResultSchema.parse(await tool('agent_configuration_version_get', {
    workspaceId, agentId, versionId: saved.agentConfigurationVersionIds[agentId],
  })).version
  assert.deepEqual(version.harness, profile.configuration)
  assert.deepEqual(version.harnessProfileSelection, selector)
  return { workspaceId, context: { workflowId: graph.id, workflowNodeId, agentId } }
}

/** Public provisioning keeps saved node, profile and location ownership separate from native execution. */
export async function provisionSessionControlSubjects(input, ports) {
  const subjects = validateSubjects(input, ports.contracts, ports.profiles, ports.placements, ports.identity)
  const defaults = ports.management.ManagedAgentDefaultsSchema.parse(await ports.tool('agent_defaults_get', {}))
  assertSessionControlDefaults(defaults)
  const prepared = []
  for (const subject of subjects) {
    const { profile, profileCheckRequest } = await qualifyProfile(subject, ports)
    const agent = await saveNode(subject, profile, ports)
    const details = { ...subject }
    for (const field of ['configuration', 'hostRef', 'parentPath', 'placement']) delete details[field]
    prepared.push({ ...details, harness: profile.driverId, hostKind: subject.hostRef.kind,
      nativeHost: subject.hostRef.deviceId ?? subject.hostRef.mainId, nativeProfile: profile.instanceId,
      model: profile.configuration.model, profileCheckRequest, agent,
      operatorDefaults: { ...defaults.value.operator, harness: profile.configuration,
        harnessProfileSelection: { instanceId: profile.instanceId, instanceRevision: profile.instanceRevision, target: profile.target } } })
  }
  return prepared
}

/** Public product provisioning, followed by twelve fresh chat admissions; no Run is allocated. */
export async function provisionSessionControlMatrix(input, ports) {
  const subjects = await provisionSessionControlSubjects(input, ports)
  return prepareSessionControlMatrix({ ...input, subjects }, ports)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2] && process.argv[3], 'Usage: provision-session-controls.mjs <fixture-installations.json> <new-matrix.json>')
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  assert.equal(input.sourceCommit, (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim())
  const product = await sessionControlProduct(input)
  try {
    const matrix = await provisionSessionControlMatrix(input, product)
    await writeFile(process.argv[3], JSON.stringify(matrix, null, 2), { flag: 'wx', mode: 0o600 })
  } finally { await product.close() }
}
