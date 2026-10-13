import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import type pg from 'pg'
import { RuntimeIdentitySchema, RuntimeBuildIdentitySchema, type RuntimeBuildIdentity } from '@foreman-code/contracts'
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

let capturedBuildIdentity: RuntimeBuildIdentity | undefined

/** Capture once at startup; a running API must keep its compiled build identity if its checkout changes. */
export function readRuntimeBuildIdentity() {
  if (capturedBuildIdentity) return capturedBuildIdentity
  const stamp = new URL('../runtime-build.json', import.meta.url)
  const identity = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) as unknown
    : createRuntimeBuildIdentity(fileURLToPath(new URL('../../../../', import.meta.url)))
  capturedBuildIdentity = RuntimeBuildIdentitySchema.parse(identity)
  return capturedBuildIdentity
}
