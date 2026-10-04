import type pg from 'pg'
import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { createRuntimeIdentity } from '@foreman-code/contracts/runtime-identity-node'

export const installationIdentityMigration = { version: 264403, sql: `
  create table application_installation (
    singleton boolean primary key default true check (singleton),
    id uuid not null default gen_random_uuid()
  );
  insert into application_installation (singleton) values (true);
` }

export async function readRuntimeIdentity(pool: Pick<pg.Pool, 'query'>, root: string, connectionString: string) {
  const result = await pool.query<{ id: string }>('select id from application_installation where singleton = true')
  return RuntimeIdentitySchema.parse(createRuntimeIdentity(root, connectionString, result.rows[0]?.id ?? ''))
}
