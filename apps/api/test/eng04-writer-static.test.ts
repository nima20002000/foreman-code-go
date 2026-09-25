import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { migrations } from '../src/infrastructure/migrations.js'
import { repeatWriterMigration, repeatWriterMigrationSql } from '../src/infrastructure/repeatWriterMigration.js'
import { wave25ApprovalMigrationSql } from '../src/modules/interactions/wave25/migration.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url))
const blob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

describe('ENG04 typed repeat writer additive source contract (not PostgreSQL execution)', () => {
  it('registers exactly one successor immediately after the unchanged 264501 migration', () => {
    const versions = migrations.map((migration) => migration.version)
    expect(versions.filter((version) => version === 264502)).toHaveLength(1)
    expect(versions[versions.indexOf(264502) - 1]).toBe(264501)
    expect(migrations[versions.indexOf(264502)]).toBe(repeatWriterMigration)
    expect(repeatWriterMigration.sql).toBe(repeatWriterMigrationSql)
  })

  it('preserves historical SQL bytes, including the already corrected 264501', () => {
    expect(blob(read('../src/infrastructure/repeatOccurrenceMigration.ts'))).toBe('0fd701a10c92bfc706ca5dd0c68c3a065e1a346c')
    expect(blob(read('../src/modules/interactions/wave25/migration.ts'))).toBe('1360e8a5e3b42d79ad6ba7a17e112e563d21ac6b')
  })

  it('retains both exact legacy v1/v2 guard predicates and their error codes', () => {
    const legacy = /if old_graph->>'executionSemanticsVersion'='2' and[\s\S]*?return NEW;/
    const oldBranch = wave25ApprovalMigrationSql.match(legacy)?.[0]
    const newBranch = repeatWriterMigrationSql.match(legacy)?.[0]
    expect(oldBranch).toBeTruthy()
    expect(newBranch).toBeTruthy()
    expect(normalize(newBranch!)).toBe(normalize(oldBranch!))
  })

  it('uses an invoker, exact transactional publication protocol rather than a role or GUC escape', () => {
    const sql = repeatWriterMigrationSql.replace(/--[^\n]*/g, '')
    expect(sql).not.toMatch(/\b(?:disable|drop)\s+trigger\b|\bsecurity\s+definer\b|\bsession_replication_role\b|\b(?:grant|revoke)\b/i)
    expect(sql).not.toContain('set_config(')
    expect(sql).toContain('create or replace function wave25_approval_no_downgrade()')
    expect(sql).toContain('before update of current_version_id,id,workspace_id,revision on workflows')
    expect(sql).toContain('deferrable initially deferred for each row execute function eng04_repeat_publication_committed()')
    expect(sql).toContain('publication_xid=pg_current_xact_id()')
    expect(sql).toContain('r.xmin=NEW.publication_xid::xid')
    expect(sql).toContain('a.xmin=NEW.publication_xid::xid')
    expect(sql).toContain('authority_id := principal.delegated_from')
    expect(sql).toContain('pg_catalog, %I, pg_temp')
  })

  it('keeps shared executable validation, live authorization and Stop admission before the typed write', () => {
    const source = read('../src/modules/repeats/authoring.ts').toString('utf8')
    expect(source).toContain('principal = await readLiveManagementPrincipal(client, principal.id)')
    expect(source).toContain('await assertMeaningfulSaveAdmitted(client,')
    expect(source).toContain('ExecutableRepeatWorkflowV1Schema.safeParse')
    expect(source.indexOf('await assertMeaningfulSaveAdmitted(client,')).toBeLessThan(source.indexOf('insert into workflow_versions'))
    expect(source.indexOf('ExecutableRepeatWorkflowV1Schema.safeParse')).toBeLessThan(source.indexOf('insert into workflow_versions'))
    expect(source.indexOf('insert into workflow_versions')).toBeLessThan(source.indexOf('eng04_publish_repeat_workflow('))
    expect(source).toContain('commandInputHash(input)')
    expect(source).not.toMatch(/update workflows set|set_config\(/i)
  })
})
