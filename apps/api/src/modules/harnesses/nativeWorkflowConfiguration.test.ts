import { expect, it } from 'vitest'
import { RETIRED_OPENCODE_MESSAGE, type RetiredOpenCodeConfiguration } from '@foreman-code/contracts'
import { assertNativeWorkflowConfiguration } from './nativeWorkflowConfiguration.js'
import { NativeConfigurationService } from './nativeConfiguration.js'
import { NativeHarnessFactories } from './runtimeFactory.js'
import { NativeRollout } from './nativeRollout.js'

const retired: RetiredOpenCodeConfiguration = {
  harness: 'opencode',
  model: 'historical/provider-model',
  variant: '',
  nativeAgent: 'build',
  thinking: true,
  autoApprove: true,
}

it('blocks retired workflow execution even when its saved settings allowed native approval', () => {
  expect(() => assertNativeWorkflowConfiguration(retired)).toThrowError(RETIRED_OPENCODE_MESSAGE)
})

it('blocks retired qualification before launching or inspecting a native process', async () => {
  const factories = new NativeHarnessFactories({ codexBinary: '/missing-codex' })
  const service = new NativeConfigurationService('/missing-codex', '/missing-directory', factories)
  await expect(factories.qualifyConfiguration(retired, '/missing-directory'))
    .rejects.toMatchObject({ code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE })
  await expect(service.qualifyConfiguration(retired))
    .rejects.toMatchObject({ code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE })
  await factories.disposeAuxiliaries()
})

it('disables retired execution while retaining supported local rollout defaults', () => {
  const rollout = new NativeRollout({ HOST: '127.0.0.1' })
  expect(rollout.enabled('opencode')).toBe(false)
  expect(rollout.enabled('codex')).toBe(true)
  expect(rollout.enabled('claude')).toBe(true)
})
