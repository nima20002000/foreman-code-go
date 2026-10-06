export const sourceCleanupLeaseMigration = {
  version: 285210,
  sql: `alter table source_execution_materializations add column cleanup_lease_expires_at timestamptz;`,
} as const
