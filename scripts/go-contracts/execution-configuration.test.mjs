import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { exportContractSchemas, installDefaultExecutionPolicy, EXECUTION_SELECTOR, FROZEN_REFERENCE } from './export-schemas.mjs'
import { goContractRuleForCheck } from '../../packages/contracts/dist/goContractRules.js'
import * as principals from '../../packages/contracts/dist/management/principals.js'

const contractsRequire = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))
const zodRoot = dirname(contractsRequire.resolve('zod/package.json'))
const { z } = await import(pathToFileURL(resolve(zodRoot, 'index.js')).href)
const source = { reference: FROZEN_REFERENCE, purpose: 'public configuration regression; not a capture receipt' }

function withConfiguration(run) {
  const before = { ...z.config() }
  try { return run() }
  finally {
    z.config({ ...Object.fromEntries(Object.keys(z.config()).map(key => [key, undefined])), ...before })
  }
}

function exported(ValueSchema, executionPolicy) {
  return exportContractSchemas({ modules: new Map([['fixture', { ValueSchema }]]),
    selected: ['fixture#ValueSchema'], source, execution: EXECUTION_SELECTOR, executionPolicy })
}

test('schema-export.execution-default-memoizer-before-binding', () => withConfiguration(() => {
  z.config({ memoizer: undefined })
  const ValueSchema = z.strictObject({ values: z.array(z.string().min(1)) })
  assert.deepEqual(ValueSchema.parse({ values: ['value'] }), { values: ['value'] })
  assert.equal(ValueSchema.safeParse({ values: [''], extra: true }).success, false)
  assert.equal(z.config().memoizer, z.memoizer())

  const principalSchema = principals.ManagementPrincipalSchema
  const principal = { id: ' owner ', name: ' Owner ', audience: 'operator', grants: [],
    expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
  const validBefore = principalSchema.safeParse(principal)
  const invalidBefore = principalSchema.safeParse({ ...principal, extra: true })
  assert.equal(validBefore.success, true)
  assert.equal(validBefore.data.id, 'owner')
  assert.equal(validBefore.data.name, 'Owner')
  assert.equal(invalidBefore.success, false)
  assert.equal(invalidBefore.error.issues[0].code, 'unrecognized_keys')

  let executionPolicy
  assert.doesNotThrow(() => { executionPolicy = installDefaultExecutionPolicy() },
    'The built-in memoizer installed by a real container must remain exportable')
  const result = exportContractSchemas({ modules: new Map([['./management', principals]]),
    selected: ['./management#ManagementPrincipalSchema'], source, ruleForCheck: goContractRuleForCheck,
    execution: EXECUTION_SELECTOR, executionPolicy })
  assert.deepEqual(result.unsupported, [])
  assert.equal(result.schemas[0].runtime.root.unknownKeys, 'strict')
  assert.equal(principals.ManagementPrincipalSchema, principalSchema)
  assert.deepEqual(principalSchema.safeParse(principal), validBefore)
  assert.deepEqual(principalSchema.safeParse({ ...principal, extra: true }).error.issues, invalidBefore.error.issues)
  assert.equal(z.config().memoizer, z.memoizer())
}))

test('schema-export.execution-default-memoizer-after-binding', () => withConfiguration(() => {
  z.config({ memoizer: undefined })
  let executionPolicy
  assert.doesNotThrow(() => { executionPolicy = installDefaultExecutionPolicy() })
  const ValueSchema = z.strictObject({ values: z.array(z.string()) })
  assert.equal(z.config().memoizer, z.memoizer())
  assert.deepEqual(ValueSchema.parse({ values: ['value'] }), { values: ['value'] })
  const result = exported(ValueSchema, executionPolicy)
  assert.deepEqual(result.unsupported, [], 'Lazy built-in configuration must keep the execution binding valid')
  assert.equal(result.schemas[0].runtime.root.unknownKeys, 'strict')
  assert.equal(z.config().memoizer, z.memoizer())
}))

test('schema-export.execution-custom-memoizer-before-binding', () => withConfiguration(() => {
  for (const memoizer of [{}, { ...z.memoizer() }, null]) {
    z.config({ memoizer })
    assert.throws(() => installDefaultExecutionPolicy(), /cannot replace nondefault Zod configuration: memoizer/)
    assert.equal(z.config().memoizer, memoizer, 'A rejected custom configuration must not be replaced')
  }
}))

test('schema-export.execution-custom-memoizer-after-binding', () => withConfiguration(() => {
  z.config({ memoizer: undefined })
  const executionPolicy = installDefaultExecutionPolicy()
  const ValueSchema = z.string()
  for (const memoizer of [{}, { ...z.memoizer() }, null]) {
    z.config({ memoizer })
    const result = exported(ValueSchema, executionPolicy)
    assert.deepEqual(result.coverage.exported, [])
    assert.equal(result.unsupported[0].issues[0].code, 'execution-configuration')
    assert.equal(z.config().memoizer, memoizer, 'Export rejection must preserve the custom configuration')
  }
}))
