import type pg from 'pg'

// Reserved migration blocks: HAP-01 100-109, HAP-02 200-209, HAP-03 300-309,
// HAP-04 400-409, HAP-05 500-509, HAP-06 600-609, HAP-07 700-709.
// Explicit versions prevent sibling worktrees from colliding when integrated.
const migrations = [
  { version: 1, sql: `
    create table if not exists application_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );

    create table if not exists workspaces (
      id text primary key,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists agents (
      id text primary key,
      workspace_id text not null references workspaces(id),
      current_configuration_version_id text,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists agent_configuration_versions (
      id text primary key,
      workspace_id text not null references workspaces(id),
      agent_id text not null references agents(id),
      version integer not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (agent_id, version)
    );

    create table if not exists workflows (
      id text primary key,
      workspace_id text not null references workspaces(id),
      current_version_id text,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists workflow_versions (
      id text primary key,
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      version integer not null,
      entry_node_id text not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (workflow_id, version)
    );

    create table if not exists runs (
      id text primary key,
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      workflow_version_id text not null references workflow_versions(id),
      execution_state text not null,
      record jsonb not null,
      created_at timestamptz not null default now()
    );

    create table if not exists harness_executions (
      id text primary key,
      run_id text not null references runs(id) on delete cascade,
      workflow_node_id text not null,
      agent_id text not null references agents(id),
      attempt integer not null,
      accepted boolean not null default false,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (run_id, workflow_node_id, attempt)
    );

    create table if not exists harness_native_events (
      execution_id text not null references harness_executions(id) on delete cascade,
      sequence integer not null,
      record jsonb not null,
      primary key (execution_id, sequence)
    );

    create table if not exists run_activity (
      run_id text not null references runs(id) on delete cascade,
      sequence bigint generated always as identity,
      source text not null,
      kind text not null,
      harness_execution_id text,
      occurred_at timestamptz not null,
      payload jsonb not null,
      primary key (run_id, sequence)
    );

    create index if not exists runs_workspace_workflow_idx
      on runs (workspace_id, workflow_id, created_at desc);
    create index if not exists harness_executions_run_idx
      on harness_executions (run_id, created_at);
    create index if not exists run_activity_run_idx
      on run_activity (run_id, sequence);
  ` },
  { version: 2, sql: `
    create table if not exists application_settings (
      key text primary key,
      record jsonb not null,
      updated_at timestamptz not null default now()
    );
  ` },
  { version: 3, sql: `
    alter table workspaces add column if not exists revision bigint not null default 1;
    alter table workspaces add column if not exists archived_at timestamptz;
    alter table workflows add column if not exists revision bigint not null default 1;
    alter table workflows add column if not exists archived_at timestamptz;
    alter table agents add column if not exists metadata_revision bigint not null default 1;
    alter table application_settings add column if not exists revision bigint not null default 1;

    create table if not exists management_principals (
      id text primary key,
      name text not null,
      audience text not null,
      token_hash text not null unique,
      grants jsonb not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      check (audience in ('operator', 'worker'))
    );

    create table if not exists management_command_receipts (
      principal_id text not null references management_principals(id),
      operation text not null,
      command_id text not null,
      target_key text not null,
      input_hash text not null,
      result jsonb not null,
      created_at timestamptz not null default now(),
      primary key (principal_id, operation, command_id)
    );

    create table if not exists management_audit (
      sequence bigint generated always as identity primary key,
      principal_id text,
      source text not null,
      action text not null,
      target_key text not null,
      outcome text not null,
      details jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now()
    );
    create index if not exists management_audit_principal_idx
      on management_audit (principal_id, sequence desc);

    create table if not exists graph_drafts (
      id text primary key,
      workspace_id text not null references workspaces(id),
      workflow_id text not null references workflows(id),
      revision bigint not null,
      base_workflow_version_id text,
      record jsonb not null,
      discarded_at timestamptz,
      updated_at timestamptz not null default now(),
      unique (workflow_id)
    );
  ` },
  { version: 4, sql: `
    alter table workspaces add column if not exists execution_location jsonb;
    alter table workspaces add column if not exists execution_location_identity jsonb;
    alter table workspaces add column if not exists location_revision bigint not null default 0;

    alter table runs add column if not exists runner_id text;
    alter table runs add column if not exists working_directory text;
    alter table runs add column if not exists location_revision bigint;

    create index if not exists runs_workspace_location_idx
      on runs (workspace_id, location_revision) where location_revision is not null;
  ` },
  { version: 100, sql: `
    create table if not exists management_principals (
      id text primary key, name text not null, audience text not null,
      token_hash text not null unique, grants jsonb not null, expires_at timestamptz not null,
      revoked_at timestamptz, created_at timestamptz not null default now(),
      check (audience in ('operator', 'worker'))
    );
    create table if not exists application_settings (
      key text primary key, record jsonb not null, updated_at timestamptz not null default now(),
      revision bigint not null default 1
    );
    alter table management_principals add column if not exists agent_id text;
    create index if not exists management_worker_agent_idx
      on management_principals (agent_id) where audience = 'worker';

    create table if not exists application_setting_versions (
      id text primary key,
      setting_key text not null,
      version integer not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (setting_key, version)
    );
    alter table application_settings add column if not exists current_version_id text;

    create table if not exists application_operators (
      id text primary key,
      current_configuration_version_id text not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists operator_configuration_versions (
      id text primary key,
      operator_id text not null references application_operators(id) deferrable initially deferred,
      version integer not null,
      record jsonb not null,
      created_at timestamptz not null default now(),
      unique (operator_id, version)
    );

    create table if not exists durable_interactions (
      id text primary key,
      workspace_id text not null,
      workflow_id text not null,
      run_id text not null,
      execution_id text not null,
      requesting_agent_id text not null,
      harness text not null,
      native_session_id text not null,
      native_request_id text not null,
      status text not null,
      revision bigint not null default 0,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (harness, native_session_id, native_request_id)
    );
    create index if not exists durable_interactions_scope_idx
      on durable_interactions (workspace_id, workflow_id, status, created_at, id);

    create table if not exists native_session_lanes (
      id text primary key,
      harness text not null,
      native_session_id text not null,
      owner_agent_id text not null,
      revision bigint not null default 0,
      record jsonb not null,
      updated_at timestamptz not null default now(),
      unique (harness, native_session_id)
    );
    create table if not exists review_jobs (
      id text primary key,
      interaction_id text not null references durable_interactions(id) on delete cascade,
      reviewer_agent_id text not null,
      state text not null,
      revision bigint not null default 0,
      record jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (interaction_id, reviewer_agent_id)
    );
  ` },
  { version: 500, sql: `
    create table if not exists approval_execution_state (
      execution_id text primary key references harness_executions(id) on delete cascade,
      graph_thread_id text not null,
      active_timeout_ms bigint not null check (active_timeout_ms > 0),
      active_elapsed_ms bigint not null default 0 check (active_elapsed_ms >= 0),
      active_started_at timestamptz,
      approval_wait_started_at timestamptz,
      stopped_at timestamptz,
      revision bigint not null default 0,
      updated_at timestamptz not null default now()
    );

    create table if not exists interaction_delivery_attempts (
      interaction_id text not null references durable_interactions(id) on delete cascade,
      attempt integer not null check (attempt > 0),
      state text not null check (state in ('submitted','uncertain','delivered','failed')),
      native_session_id text not null,
      native_request_id text not null,
      correlation_id text not null,
      error text,
      created_at timestamptz not null default now(),
      primary key (interaction_id, attempt)
    );
    create index if not exists interaction_delivery_attempts_reconcile_idx
      on interaction_delivery_attempts (state, created_at, interaction_id);
  ` },
] as const

export async function applyApplicationMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1)', [810_001])
    await client.query(`
      create table if not exists application_migrations (
        version integer primary key,
        applied_at timestamptz not null default now()
      )
    `)
    const applied = await client.query<{ version: number }>('select version from application_migrations')
    const appliedVersions = new Set(applied.rows.map((row) => row.version))
    for (const migration of migrations) {
      const { version } = migration
      if (appliedVersions.has(version)) continue
      await client.query(migration.sql)
      await client.query('insert into application_migrations (version) values ($1)', [version])
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
