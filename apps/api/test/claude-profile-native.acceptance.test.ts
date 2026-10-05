import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { claudeQualificationCapabilities } from '@foreman-code/contracts/claude-qualification'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { createClaudeCurrentPinResolver, installedClaudeSdkEntrypoint } from '../src/modules/harnesses/claudeSdk/currentPin.js'
import { qualifyClaudeNativeProfile } from '../src/modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { CLAUDE_CLI_CANDIDATE_VERSION, CLAUDE_SDK_CANDIDATE_VERSION } from '../src/modules/harnesses/claudeSdk/official.js'
import { probeTrustedVersion } from '../src/modules/harnesses/hostDiscovery.js'
import { HarnessInstallationRegistry } from '../src/modules/harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'

it.runIf(process.env.RUN_CLAUDE_PROFILE_NATIVE_TESTS === '1')(
  'qualifies the installed Haiku profile through real native lifecycle and tool-policy scenarios', async () => {
    const evidenceRoot = process.env.ENG03_A_EVIDENCE_DIR
    if (!evidenceRoot) throw new Error('Native qualification requires the root runner evidence directory.')
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(evidenceRoot, 'claude-haiku-'))
    const configuration = ClaudeHarnessConfigurationSchema.parse({
      harness: 'claude', model: 'claude-haiku-4-5-20251001', authMode: 'subscription',
      configDirectory: resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')),
      permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Write'],
      permissionRules: [], instructions: '', mcpServers: {},
    })
    const instanceId = randomUUID()
    const hostRef = { kind: 'main' as const, mainId: randomUUID() }
    const environment = { generation: randomUUID(), provenance: 'terminal' as const,
      cwd: directory, path: process.env.PATH ?? '' }
    const sdkEntrypoint = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const binary = createRequire(sdkEntrypoint).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`)
    const context = { hostGeneration: randomUUID(), harnessInstallationId: commandInputHash({ hostRef, binary }),
      environment, instanceRevision: commandInputHash(configuration), profilePath: configuration.configDirectory }
    const signal = AbortSignal.timeout(240_000)
    const currentPin = createClaudeCurrentPinResolver({
      sdk: installedClaudeSdkEntrypoint(fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)), binary),
      ownedVersionProbe: async input => {
        const probe = await probeTrustedVersion({ launcher: input.launcher, allowlistedLaunchers: [input.launcher],
          environment: process.env, neutralCwd: directory })
        expect(probe.status).toBe('observed')
        expect(probe.exitCode).toBe(0)
        const version = probe.stdout.trim().match(/^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/)?.[1]
        if (!version) throw new Error('The installed Claude CLI returned no recognized version.')
        return { ...input, version, positiveProcessClosure: true }
      },
    })
    const current = await currentPin(context, signal)
    if (current.status !== 'available') throw new Error(current.reason)
    expect(current.pin.sdkVersion).toBe(CLAUDE_SDK_CANDIDATE_VERSION)
    expect(current.pin.cliVersion).toBe(CLAUDE_CLI_CANDIDATE_VERSION)
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId, instanceRevision: context.instanceRevision,
      driverId: 'claude', enabled: true, configuration }])
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh([{ hostRef, harnessInstallationId: context.harnessInstallationId,
      installationFingerprint: current.launcher.fingerprint, launcher: current.launcher,
      driverId: 'claude', driverRevision: '1', protocolRevision: current.declaration.protocolRevision,
      environmentGeneration: environment.generation, connectionGeneration: context.hostGeneration,
      observedVersion: current.pin.cliVersion, installed: true, authenticated: null, compatible: null, qualified: null }])
    const binding = installations.pin({ instanceId, hostRef, harnessInstallationId: context.harnessInstallationId,
      connectionGeneration: context.hostGeneration, environmentGeneration: environment.generation })
    const value = HostHarnessOverrideSchema.parse({ instanceId, instanceRevision: context.instanceRevision, revision: 1,
      target: { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: context.harnessInstallationId,
        installationFingerprint: binding.selection.installationFingerprint },
      presetId: 'native-haiku-qualification', enabled: true, driverId: 'claude', configuration,
      configurationFingerprint: commandInputHash(configuration), qualification: 'unqualified' })
    const processes = new NativeProcessRegistry(join(directory, 'processes'))
    const recovery = processes.reserveLaunch(`claude-profile-check:${randomUUID()}`)
    try {
      const proof = await qualifyClaudeNativeProfile({ value, checkId: randomUUID(), binding, pin: current.pin,
        directory, recovery, signal, assertCurrent: async () => {
          installations.assertCurrent(binding)
          const refreshed = await currentPin(context, signal)
          expect(refreshed.status).toBe('available')
          if (refreshed.status === 'available') expect(refreshed.pin).toEqual(current.pin)
        } })
      const artifact = join(directory, 'qualification.json')
      await writeFile(artifact, JSON.stringify({ model: configuration.model, proof }, null, 2), { mode: 0o600 })
      console.info(`Claude Haiku qualification evidence ${artifact}`)
      expect(proof, JSON.stringify(proof.failure)).toMatchObject({ authenticated: true, compatible: true, qualified: true })
      expect(proof.claudeProof?.pin).toEqual(current.pin)
      expect(proof.claudeProof?.observedTools).toContain('Write')
      expect(claudeQualificationCapabilities(proof.claudeProof!)).toMatchObject({
        basicTurns: true, resume: true, fork: true, history: true, workingDirectory: true,
        policy: { settingsIsolation: true, backgroundTasksDisabled: true, alwaysAppliedToolHook: true, fullAccessPolicy: true },
      })
    } finally {
      await processes.abandonReservedLaunch(recovery)
      expect(await processes.closeOwner(recovery.owner)).toBe(true)
    }
  }, 240_000,
)
