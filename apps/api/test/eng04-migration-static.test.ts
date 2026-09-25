import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrations } from '../src/infrastructure/migrations.js'
import { repeatOccurrenceMigration, repeatOccurrenceMigrationSql } from '../src/infrastructure/repeatOccurrenceMigration.js'

// Static guardrails only. Passing these is NOT PostgreSQL migration qualification.
describe('ENG04 migration successor registry/static guardrails', () => {
  it('has one collision-free final registration and retains the original raw SQL export', () => {
    expect(repeatOccurrenceMigration.version).toBe(264501)
    expect(repeatOccurrenceMigration.sql).toBe(repeatOccurrenceMigrationSql)
    expect(migrations.at(-1)).toBe(repeatOccurrenceMigration)
    expect(migrations.filter((migration) => migration.version === 264501)).toHaveLength(1)
    expect(new Set(migrations.map((migration) => migration.version)).size).toBe(migrations.length)
  })

  it('leaves the full pinned registry byte-for-byte unchanged apart from import and tail append', () => {
    const source = readFileSync(new URL('../src/infrastructure/migrations.ts', import.meta.url), 'utf8')
    const original = source
      .replace("import { repeatOccurrenceMigration } from './repeatOccurrenceMigration.js'\n", '')
      .replace('  repeatOccurrenceMigration,\n', '')
    expect(createHash('sha256').update(original).digest('hex')).toBe('cb8847ce0d3b0a05aae57018d0d3e38dfc4fe38f4e23b06b1299fbe8bd0aadee')
  })

  it('does not silently skip drift, rewrite legacy rows or require pgcrypto', () => {
    expect(repeatOccurrenceMigrationSql).toContain('REPEAT_SEMANTICS_CONSTRAINT_DRIFT')
    expect(repeatOccurrenceMigrationSql).toContain('REPEAT_LEGACY_UNIQUENESS_DRIFT')
    expect(repeatOccurrenceMigrationSql).toContain('check (execution_semantics_version in (1,2,3))')
    expect(repeatOccurrenceMigrationSql).not.toMatch(/create\s+extension/i)
    expect(repeatOccurrenceMigrationSql).not.toMatch(/update\s+(workflow_versions|runs|harness_executions)\s+set/i)
    expect(repeatOccurrenceMigrationSql).not.toMatch(/drop\s+(?:index|constraint)\s+run_graph_execution_identity/i)
  })
})
