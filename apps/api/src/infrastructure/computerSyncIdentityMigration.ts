export const computerSyncIdentityMigration = { version: 2026101604, sql: `
create table computer_sync_identities (
 host_key text not null, target jsonb not null, identity jsonb not null,
 primary key(host_key,target)
);
` }
