import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export function isBackwardCompatibleSchema(before, after) {
  const previous = new Map(before.map(object => [object.key, object]))
  const migrated = new Map(after.map(object => [object.key, object]))
  for (const object of before) {
    if (!isDeepStrictEqual(object.definition, migrated.get(object.key)?.definition)) return false
  }
  for (const object of after) {
    if (previous.has(object.key) || object.additive) continue
    if (object.parent && migrated.has(object.parent) && !previous.has(object.parent)) continue
    return false
  }
  return true
}

export async function readMigrationSchema(release, databaseUrl) {
  const require = createRequire(join(release, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
    query_timeout: 5000 })
  try {
    // Compare the existing database interfaces, allowing additions that preserve old reads and writes.
    const { rows } = await pool.query(`
      with namespaces as (
        select oid, nspname from pg_namespace
        where nspname not like 'pg_%' and nspname <> 'information_schema'
      ), relations as (
        select c.*, format('%I.%I', n.nspname, c.relname) as name
        from pg_class c join namespaces n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'c', 'f')
      ), types as (
        select t.*, format('%I.%I', n.nspname, t.typname) as name
        from pg_type t join namespaces n on n.oid = t.typnamespace
        where t.typtype in ('e', 'd')
      )
      select 'table:' || r.name as key, null::text as parent, true as additive,
        jsonb_build_object('kind', r.relkind, 'persistence', r.relpersistence,
          'rowSecurity', r.relrowsecurity, 'forceRowSecurity', r.relforcerowsecurity,
          'owner', r.relowner, 'acl', r.relacl,
          'view', case when r.relkind in ('v', 'm') then pg_get_viewdef(r.oid, true) end,
          'partition', case when r.relkind = 'p' then pg_get_partkeydef(r.oid) end,
          'bound', pg_get_expr(r.relpartbound, r.oid)) as definition
      from relations r
      union all
      select 'column:' || r.name || '.' || quote_ident(a.attname), 'table:' || r.name,
        not a.attnotnull or d.oid is not null or a.attidentity <> '' or a.attgenerated <> '',
        jsonb_build_object('type', format_type(a.atttypid, a.atttypmod), 'nullable', not a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity,
          'generated', a.attgenerated, 'collation', a.attcollation, 'acl', a.attacl)
      from relations r join pg_attribute a on a.attrelid = r.oid
      left join pg_attrdef d on d.adrelid = r.oid and d.adnum = a.attnum
      where a.attnum > 0 and not a.attisdropped
      union all
      select 'constraint:' || coalesce(r.name, t.name) || '.' || quote_ident(c.conname),
        case when r.oid is not null then 'table:' || r.name else 'type:' || t.name end, false,
        jsonb_build_object('definition', pg_get_constraintdef(c.oid, true), 'validated', c.convalidated)
      from pg_constraint c
      left join relations r on r.oid = c.conrelid left join types t on t.oid = c.contypid
      where r.oid is not null or t.oid is not null
      union all
      select 'index:' || r.name || '.' || quote_ident(c.relname), 'table:' || r.name,
        not i.indisunique and not i.indisexclusion,
        jsonb_build_object('definition', pg_get_indexdef(i.indexrelid),
          'valid', i.indisvalid, 'replicaIdentity', i.indisreplident)
      from pg_index i join relations r on r.oid = i.indrelid join pg_class c on c.oid = i.indexrelid
      union all
      select 'trigger:' || r.name || '.' || quote_ident(t.tgname), 'table:' || r.name, false,
        jsonb_build_object('definition', pg_get_triggerdef(t.oid, true), 'enabled', t.tgenabled)
      from pg_trigger t join relations r on r.oid = t.tgrelid where not t.tgisinternal
      union all
      select 'policy:' || r.name || '.' || quote_ident(p.polname), 'table:' || r.name, false,
        to_jsonb(p) - 'oid' - 'polrelid'
      from pg_policy p join relations r on r.oid = p.polrelid
      union all
      select 'function:' || format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
        null, true, jsonb_build_object('definition', pg_get_functiondef(p.oid), 'owner', p.proowner, 'acl', p.proacl)
      from pg_proc p join namespaces n on n.oid = p.pronamespace where p.prokind in ('f', 'p')
      union all
      select 'type:' || t.name, null, true,
        jsonb_build_object('kind', t.typtype, 'base', format_type(t.typbasetype, t.typtypmod),
          'nullable', not t.typnotnull, 'default', t.typdefault,
          'enum', (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid))
      from types t
      union all
      select 'sequence:' || format('%I.%I', n.nspname, c.relname), null, true,
        to_jsonb(s) - 'seqrelid'
      from pg_sequence s join pg_class c on c.oid = s.seqrelid join namespaces n on n.oid = c.relnamespace
      union all
      select 'extension:' || e.extname, null, true,
        jsonb_build_object('version', e.extversion, 'namespace', e.extnamespace)
      from pg_extension e
    `)
    return rows
  } finally {
    await pool.end()
  }
}
