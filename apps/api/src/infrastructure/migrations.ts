import type pg from 'pg'

const migrations = [
  `
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
  `,
  `
    create table if not exists application_settings (
      key text primary key,
      record jsonb not null,
      updated_at timestamptz not null default now()
    );
  `,
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
    for (const [index, migration] of migrations.entries()) {
      const version = index + 1
      if (appliedVersions.has(version)) continue
      await client.query(migration)
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
