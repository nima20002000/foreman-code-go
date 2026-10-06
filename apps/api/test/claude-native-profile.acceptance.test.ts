import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { deleteSession, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { claudeQualificationCapabilities } from '@foreman-code/contracts/claude-qualification'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { createClaudeCurrentPinResolver, discoverInstalledClaudeSdk, installedClaudeSdkEntrypoint } from '../src/modules/harnesses/claudeSdk/currentPin.js'
import { qualifyClaudeNativeProfile } from '../src/modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'

// Explicit full-access qualification authorizes only its disposable Write fixtures.
it.skipIf(process.env.RUN_CLAUDE_NATIVE_PROFILE_TESTS !== '1' || process.platform !== 'linux')(
  'verifies the installed Claude SDK and CLI with Haiku native receipts, resume and policy checks', async () => {
    const selected = process.env.CLAUDE_LIVE_BINARY
    assert(selected && isAbsolute(selected), 'Select the actual installed Claude executable with CLAUDE_LIVE_BINARY.')
    const binary = await realpath(selected)
    const root = await mkdtemp(join(tmpdir(), 'claude-native-'))
    try {
      await verifyInstalledClaude(root, binary)
    } finally {
      try {
        for (const directory of await readdir(root)) {
          if (!directory.startsWith('claude-profile-')) continue
          const cwd = join(root, directory, 'work')
          const sessions = await listSessions({ dir: cwd, includeWorktrees: false })
          for (const session of sessions) {
            assert.equal(session.cwd, cwd)
            await deleteSession(session.sessionId, { dir: cwd })
          }
          assert.deepEqual(await listSessions({ dir: cwd, includeWorktrees: false }), [])
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 360_000)

async function verifyInstalledClaude(root: string, binary: string) {
  const processRegistry = new NativeProcessRegistry(join(root, 'native-process-registry'))
  const configuration = ClaudeHarnessConfigurationSchema.parse({
    harness: 'claude', model: 'claude-haiku-4-5-20251001',
    configDirectory: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    authMode: 'subscription', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {},
  })
  const hostRef = { kind: 'main' as const, mainId: randomUUID() }
  const harnessInstallationId = commandInputHash({ hostRef, binary })
  const environment = { path: process.env.PATH ?? '', cwd: root, provenance: 'terminal' as const,
    generation: commandInputHash({ path: process.env.PATH, cwd: root, node: process.execPath }) }
  const sdk = installedClaudeSdkEntrypoint(fileURLToPath(new URL('../../../node_modules/.pnpm/lock.yaml', import.meta.url)), binary)
  const discovered = await discoverInstalledClaudeSdk(sdk, { harnessInstallationId, environment })
  assert(discovered.launcher.fingerprint)
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  const instanceId = randomUUID()
  instances.reload([{ instanceId, instanceRevision: '1', driverId: 'claude', enabled: true, configuration }])
  const installations = new HarnessInstallationRegistry(instances)
  const connectionGeneration = randomUUID()
  installations.refresh([{ hostRef, harnessInstallationId, installationFingerprint: discovered.launcher.fingerprint,
    driverId: 'claude', driverRevision: discovered.declaration.driverRevision,
    protocolRevision: discovered.declaration.protocolRevision, environmentGeneration: environment.generation,
    connectionGeneration, launcher: discovered.launcher, observedVersion: null,
    installed: true, authenticated: null, compatible: null, qualified: null }])
  const binding = installations.pin({ instanceId, hostRef, harnessInstallationId,
    connectionGeneration, environmentGeneration: environment.generation })
  const factories = new NativeHarnessFactories({ codexBinary: 'unused', openCodeBinary: 'unused', instances, installations,
    auxiliaryRecovery: () => processRegistry.scope(`claude-version:${randomUUID()}`),
    admitRecovery: scope => Object.assign(scope, processRegistry.reserveLaunch(scope.owner)),
    abandonRecovery: async scope => { await processRegistry.abandonReservedLaunch(scope) },
    closeRecovery: async scope => { assert.equal(await processRegistry.closeOwner(scope.owner), true) },
    claudeVersionCommand: runCommand,
  })
  const signal = AbortSignal.timeout(240_000)
  const currentContext = { hostGeneration: connectionGeneration, harnessInstallationId, environment,
    instanceRevision: '1', profilePath: configuration.configDirectory }
  const current = createClaudeCurrentPinResolver({ sdk,
    ownedVersionProbe: input => factories.observeClaudeVersion(binding, root, input.signal) })
  const owner = `claude-profile:${randomUUID()}`
  let qualified = false
  try {
    const observed = await current(currentContext, signal)
    if (observed.status === 'unavailable') assert.fail(observed.reason)
    const target = { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId,
      installationFingerprint: discovered.launcher.fingerprint }
    const value: HostHarnessOverride = { instanceId, instanceRevision: '1', revision: 1, target,
      presetId: 'native-haiku-qualification', enabled: true, driverId: 'claude', configuration,
      configurationFingerprint: commandInputHash(configuration), qualification: 'unqualified' }
    const proof = await qualifyClaudeNativeProfile({ value, checkId: randomUUID(), binding, pin: observed.pin,
      directory: root, recovery: processRegistry.scope(owner), signal,
      assertCurrent: async () => {
        await factories.assertInstallationUnchanged(binding, signal)
        const replacement = await current(currentContext, signal)
        if (replacement.status === 'unavailable') assert.fail(replacement.reason)
        assert.deepEqual(replacement.pin, observed.pin)
      },
    })
    assert.equal(proof.qualified, true, JSON.stringify(proof.failure))
    qualified = true
    assert.equal(proof.authenticated, true)
    assert.equal(proof.compatible, true)
    assert.deepEqual(proof.claudeProof?.pin, observed.pin)
    assert(proof.claudeProof)
    const capabilities = claudeQualificationCapabilities(proof.claudeProof)
    assert.equal(capabilities.basicTurns, true)
    assert.equal(capabilities.resume, true)
    assert.equal(capabilities.fork, true)
    assert.equal(capabilities.history, true)
    assert.equal(capabilities.policy.alwaysAppliedToolHook, true)
    assert.equal(capabilities.policy.fullAccessPolicy, true)
    const evidencePath = proof.claudeProof.checks.firstSecondTurn?.evidenceId
    assert(evidencePath)
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as { model: string; receipts: unknown[] }
    assert.equal(evidence.model, configuration.model)
    assert(evidence.receipts.length > 0)
  } finally {
    try { await factories.disposeAuxiliaries() }
    finally {
      const closed = await processRegistry.closeOwner(owner)
      if (qualified) assert.equal(closed, true)
    }
  }
}
