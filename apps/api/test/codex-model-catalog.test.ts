import { rm, writeFile } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { parseCodexModelCatalog } from '../src/modules/harnesses/codexModelCatalog.js'
import { qualifyNativeCodexModel } from '../src/modules/harnesses/codexQualification.js'
import { calls, fixture, fixtureQualification } from './fixtures/codex-test-helpers.js'
import { join } from 'node:path'

const model = { slug: 'test-model', supported_reasoning_levels: [{ effort: 'medium' }],
  additional_speed_tiers: ['fast'] }
const result = (models: unknown, stderr = '') => ({ exitCode: 0, stdout: JSON.stringify({ models }), stderr })
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true }))) })

it('reports failed remote refresh as a retryable read failure even when fallback models are returned successfully', () => {
  const stderr = 'ERROR models_manager: failed to refresh available models: private provider detail'
  for (const models of [[], [model]]) {
    expect(() => parseCodexModelCatalog(result(models, stderr))).toThrow(expect.objectContaining({
      result: { outcome: 'failed', error: { code: 'CODEX_MODEL_CATALOG_UNAVAILABLE', retryable: true,
        message: expect.not.stringContaining('private provider detail') } },
    }))
  }
})

it('keeps successful discovery when only native cache loading or saving fails', () => {
  const catalog = result([model], 'Failed to read models cache\nFailed to persist models cache')
  expect(parseCodexModelCatalog(catalog).models).toEqual([model])
})

it.each([undefined, null, {}, [null], ['test-model'], [{ slug: 'test-model' }],
  [{ ...model, supported_reasoning_levels: ['medium'] }],
  [{ ...model, additional_speed_tiers: [1] }], [model, model]])(
  'rejects malformed or ambiguous native catalogs without silently discarding entries: %j', models => {
    expect(() => parseCodexModelCatalog(result(models))).toThrow(expect.objectContaining({
      result: expect.objectContaining({ error: expect.objectContaining({ code: 'CODEX_MODEL_CATALOG_INVALID' }) }),
    }))
  })

it('bounds native catalog size and preserves the parse cause', () => {
  expect(() => parseCodexModelCatalog(result(Array.from({ length: 10_001 }, () => model))))
    .toThrow(expect.objectContaining({ result: expect.objectContaining({
      error: expect.objectContaining({ code: 'CODEX_MODEL_CATALOG_INVALID' }),
    }) }))
  expect(() => parseCodexModelCatalog({ exitCode: 0, stdout: '{', stderr: '' }))
    .toThrow(expect.objectContaining({ cause: expect.any(SyntaxError) }))
})

async function native(models: unknown, refreshFlag?: string) {
  const f = await fixture()
  directories.push(f.directory)
  await writeFile(join(f.directory, 'models.json'), JSON.stringify({ models }))
  if (refreshFlag) await writeFile(join(f.directory, refreshFlag), '')
  const qualified = await fixtureQualification(f.binary, undefined, f.directory, {}, true)
  return { ...f, inspection: { qualified, assertUnchanged: async () => undefined } }
}

it('checks the exact model, effort and tier through validated stdio without creating an inference thread', async () => {
  const f = await native([model])
  const configuration = { ...DEFAULT_HARNESS_DEFAULTS.codex, model: model.slug,
    reasoningEffort: 'medium', serviceTier: 'priority' as const }
  const qualify = (value: typeof configuration) => qualifyNativeCodexModel(value,
    f.binary, f.directory, {}, undefined, undefined, f.inspection)
  await qualify(configuration)
  await expect(qualify({ ...configuration, model: 'absent' }))
    .rejects.toMatchObject({ result: { error: { code: 'CODEX_MODEL_UNAVAILABLE' } } })
  await expect(qualify({ ...configuration, reasoningEffort: 'high' }))
    .rejects.toMatchObject({ result: { error: { code: 'CODEX_SETTING_UNSUPPORTED' } } })
  const wire = (await calls(f.directory)).filter(entry => entry.wire).map(entry => entry.wire as { method: string })
  expect(wire.filter(entry => entry.method === 'model/list')).toHaveLength(3)
  expect(wire.some(entry => ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method))).toBe(false)
  expect(configuration.model).toBe('test-model')
})

it.each(['models-refresh-failed', 'models-refresh-failed-on-close'])(
  'rejects fallback models after stderr is drained, without a model retry or native thread: %s', async flag => {
    const f = await native([model], flag)
    await expect(qualifyNativeCodexModel({ ...DEFAULT_HARNESS_DEFAULTS.codex,
      model: model.slug, reasoningEffort: 'medium' }, f.binary, f.directory, {}, undefined, undefined, f.inspection))
      .rejects.toMatchObject({ result: { error: { code: 'CODEX_MODEL_CATALOG_UNAVAILABLE', retryable: true } } })
    const wire = (await calls(f.directory)).filter(entry => entry.wire).map(entry => entry.wire as { method: string })
    expect(wire.filter(entry => entry.method === 'model/list')).toHaveLength(1)
    expect(wire.some(entry => ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method))).toBe(false)
  })
