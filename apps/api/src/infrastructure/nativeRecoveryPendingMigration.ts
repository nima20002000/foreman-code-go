export const nativeRecoveryPendingMigration = {
  version: 2026100911,
  sql: `alter table execution_native_closures add column recovery_requested_at timestamptz;`,
} as const
