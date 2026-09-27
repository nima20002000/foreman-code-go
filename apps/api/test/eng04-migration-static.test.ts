import { describe, expect, it } from 'vitest'
import { migrations } from '../src/infrastructure/migrations.js'
import { repeatOccurrenceMigration, repeatOccurrenceMigrationSql } from '../src/infrastructure/repeatOccurrenceMigration.js'

// Static guardrails only. Passing these is NOT PostgreSQL migration qualification.
describe('ENG04 migration successor registry/static guardrails', () => {
  it('has one collision-free final registration and retains the original raw SQL export', () => {
    expect(repeatOccurrenceMigration.version).toBe(264501)
    expect(repeatOccurrenceMigration.sql).toBe(repeatOccurrenceMigrationSql)
    const index = migrations.findIndex((migration) => migration.version === repeatOccurrenceMigration.version)
    expect(index).toBeGreaterThan(-1)
    expect(migrations[index]).toBe(repeatOccurrenceMigration)
    expect(migrations.filter((migration) => migration.version === 264501)).toHaveLength(1)
    expect(new Set(migrations.map((migration) => migration.version)).size).toBe(migrations.length)
  })

  it('keeps the occurrence migration before every later writer and native lifecycle migration', () => {
    const versions = migrations.map((migration) => migration.version)
    const occurrence = versions.indexOf(repeatOccurrenceMigration.version)
    expect(versions.indexOf(264502)).toBe(occurrence + 1)
    // Later unrelated migrations may carry lower numbers (264402-264405 were appended after it and are
    // already applied, so they cannot be renumbered). No later writer may be placed before it.
    expect(versions.slice(0, occurrence).every((version) => version < repeatOccurrenceMigration.version)).toBe(true)
  })

  it('does not silently skip drift, rewrite legacy rows or require pgcrypto', () => {
    expect(repeatOccurrenceMigrationSql).toContain('REPEAT_SEMANTICS_CONSTRAINT_DRIFT')
    expect(repeatOccurrenceMigrationSql).toContain('REPEAT_LEGACY_UNIQUENESS_DRIFT')
    expect(repeatOccurrenceMigrationSql).not.toMatch(/create\s+extension/i)
    expect(repeatOccurrenceMigrationSql).not.toMatch(/update\s+(workflow_versions|runs|harness_executions)\s+set/i)
    expect(repeatOccurrenceMigrationSql).not.toMatch(/drop\s+(?:index|constraint)\s+run_graph_execution_identity/i)
  })
})
