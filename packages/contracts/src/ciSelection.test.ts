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

it('rejects incomplete affected scope, traversal, unsupported suites and mixing full scope with selections', () => {
  for (const invalid of [{ ...input, commit: undefined }, { ...input, files: undefined },
    { ...input, files: ['apps/api/../escape.test.ts'] }, { ...input, files: ['apps/api/src/feature.ts'] },
    { ...input, files: ['apps/api/test/feature.integration.test.ts'] }, { ...input, suite: 'build' },
    { ...input, scope: 'full' }]) expect(CiRunInputSchema.safeParse(invalid).success).toBe(false)
  expect(CiRunInputSchema.safeParse({ ...input, files: ['apps/web/src/feature.integration.test.tsx'] }).success).toBe(true)
  expect(CiRunInputSchema.safeParse({ ...input, files: [] }).success).toBe(true)
  expect(CiRunInputSchema.safeParse({ suite: 'unit', commandId: 'full' }).success).toBe(true)
})
