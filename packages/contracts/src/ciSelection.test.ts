import { expect, it } from 'vitest'
import { CiRunInputSchema, OperatorCiRunInputSchema } from './ci.js'
import { CiHostRequestSchema } from './ciHost.js'

const input = { suite: 'unit', scope: 'affected', files: ['apps/api/src/feature.test.ts'],
  commit: 'a'.repeat(40), commandId: 'affected' }

it('accepts affected scope through Agent, Operator and host contracts', () => {
  expect(CiRunInputSchema.parse(input)).toEqual(input)
  expect(OperatorCiRunInputSchema.parse({ ...input, workspaceId: 'workspace-ci' })).toMatchObject(input)
  expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/project', suite: input.suite, commit: input.commit, scope: input.scope, files: input.files }))
    .toMatchObject({ scope: 'affected', files: input.files })
})

it('accepts execution parts with their suite and permits shards only on unit-api, unit-web and unit-web-heavy', () => {
  const start = { operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
    repository: 'example/project', suite: 'unit', commit: 'a'.repeat(40), part: 'unit-api',
    partition: { index: 0, count: 5 } }
  expect(CiHostRequestSchema.parse(start)).toMatchObject({ part: 'unit-api', partition: { index: 0, count: 5 } })
  expect(CiHostRequestSchema.safeParse({ ...start, part: 'unit-web-heavy', partition: { index: 1, count: 2 } }).success).toBe(true)
  for (const invalid of [{ ...start, suite: 'build' }, { ...start, part: 'unit-other' }, { ...start, part: undefined }]) {
    expect(CiHostRequestSchema.safeParse(invalid).success).toBe(false)
  }
  expect(CiRunInputSchema.safeParse({ suite: 'unit-api', commandId: 'part' }).success).toBe(false)
})

it('accepts runner selection without caller files or a caller commit for every suite', () => {
  for (const suite of ['unit', 'integration', 'lint', 'typecheck', 'install', 'build']) {
    for (const scope of [undefined, 'affected', 'full']) {
      const request = { suite, commandId: 'runner-selection', ...(scope ? { scope } : {}) }
      expect(CiRunInputSchema.parse(request)).toEqual(request)
      expect(OperatorCiRunInputSchema.parse({ ...request, workspaceId: 'workspace-ci' })).toMatchObject(request)
      expect(CiHostRequestSchema.parse({ operation: 'start', runId: '00000000-0000-4000-8000-000000000001',
        repository: 'example/project', commit: input.commit, defaultBranch: 'release/stable', suite,
        ...(scope ? { scope } : {}) })).toMatchObject({ suite, defaultBranch: 'release/stable' })
    }
  }
  expect(CiRunInputSchema.parse({ ...input, scope: undefined })).toMatchObject({ files: input.files })
})

it('rejects unpinned caller selections, traversal, unsupported selected suites and mixing full scope with selections', () => {
  for (const invalid of [{ ...input, commit: undefined },
    { ...input, files: ['apps/api/../escape.test.ts'] }, { ...input, files: ['apps/api/src/feature.ts'] },
    { ...input, files: ['apps/api/test/feature.integration.test.ts'] }, { ...input, suite: 'build' },
    { ...input, scope: 'full' }]) expect(CiRunInputSchema.safeParse(invalid).success).toBe(false)
  expect(CiRunInputSchema.safeParse({ ...input, files: ['apps/web/src/feature.integration.test.tsx'] }).success).toBe(true)
  expect(CiRunInputSchema.safeParse({ ...input, files: [] }).success).toBe(true)
  expect(CiRunInputSchema.safeParse({ suite: 'unit', scope: 'full', commandId: 'full' }).success).toBe(true)
})
