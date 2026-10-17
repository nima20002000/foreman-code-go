//go:build integration

package schema_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

const capturedCheckpointSchema = "langgraph"

func schemaContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

type appliedMigration struct {
	version   int64
	appliedAt time.Time
}

type baselineState struct {
	history       []appliedMigration
	installation  string
	localHuman    string
	humanAudience string
}

// Every acceptance case starts from the real embedded capture. A missing dump
// or unavailable CI database is a failure, never a skipped or passing case.
func capturedDatabase(t *testing.T) (*database.DB, config.Database) {
	t.Helper()
	fixture := testdb.New(t)
	options := fixture.Config()
	pool := openSchemaPool(t, options)
	if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
		t.Fatalf("initialize fresh database from captured TypeScript baseline: %v", err)
	}
	state := readBaselineState(t, pool)
	validateCapturedHead(t, state.history)
	if state.installation == "" || state.localHuman == "" || state.humanAudience != "operator" {
		t.Fatal("captured baseline did not restore its installation and local-human seed records")
	}
	if err := schema.CheckpointProbe(pool, capturedCheckpointSchema).Ping(schemaContext(t)); err != nil {
		t.Fatalf("captured checkpoint tables are not ready: %v", err)
	}
	return pool, options
}

func openSchemaPool(t *testing.T, options config.Database) *database.DB {
	t.Helper()
	options.MaxConnections = 1
	options.QueryTimeout = 30 * time.Minute
	options.LockTimeout = 5 * time.Second
	pool, err := database.OpenPool(schemaContext(t), options, "schema-integration", nil)
	if err != nil {
		t.Fatalf("open isolated schema database: %v", err)
	}
	// The fixture's cleanup was registered first, so all pools close before DROP.
	t.Cleanup(pool.Close)
	return pool
}

func validateCapturedHead(t *testing.T, history []appliedMigration) {
	t.Helper()
	baseline, err := schema.Embedded()
	if err != nil {
		t.Fatalf("load embedded baseline: %v", err)
	}
	if err := baseline.CheckHead(migrationVersions(history)); err != nil {
		t.Fatalf("persisted history differs from the embedded TypeScript head: %v", err)
	}
}

func migrationVersions(history []appliedMigration) []int64 {
	versions := make([]int64, len(history))
	for i, migration := range history {
		versions[i] = migration.version
	}
	return versions
}

func readBaselineState(t *testing.T, pool *database.DB) baselineState {
	t.Helper()
	state := baselineState{history: readApplicationHistory(t, pool)}
	if err := pool.Pool().QueryRow(schemaContext(t),
		"select id::text from public.application_installation where singleton = true").Scan(&state.installation); err != nil {
		t.Fatalf("read persisted installation: %v", err)
	}
	if err := pool.Pool().QueryRow(schemaContext(t), `
		select h.principal_id, p.audience
		from public.local_human_principal h
		join public.management_principals p on p.id = h.principal_id
		where h.singleton = true`).Scan(&state.localHuman, &state.humanAudience); err != nil {
		t.Fatalf("read persisted local-human principal: %v", err)
	}
	return state
}

func readApplicationHistory(t *testing.T, pool *database.DB) []appliedMigration {
	t.Helper()
	rows, err := pool.Pool().Query(schemaContext(t), "select version::bigint, applied_at from public.application_migrations order by version")
	if err != nil {
		t.Fatalf("read persisted migration history: %v", err)
	}
	defer rows.Close()
	var history []appliedMigration
	for rows.Next() {
		var migration appliedMigration
		if err := rows.Scan(&migration.version, &migration.appliedAt); err != nil {
			t.Fatalf("read persisted migration record: %v", err)
		}
		migration.appliedAt = migration.appliedAt.UTC()
		history = append(history, migration)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("finish persisted migration history: %v", err)
	}
	return history
}

func requireBaselineUnchanged(t *testing.T, pool *database.DB, before baselineState) {
	t.Helper()
	if after := readBaselineState(t, pool); !reflect.DeepEqual(after, before) {
		t.Fatal("startup changed persisted application history or migration seed identity")
	}
}

func tableExists(t *testing.T, pool *database.DB, name string) bool {
	t.Helper()
	var exists bool
	if err := pool.Pool().QueryRow(schemaContext(t), "select to_regclass($1) is not null", name).Scan(&exists); err != nil {
		t.Fatalf("inspect persisted table: %v", err)
	}
	return exists
}

func executeFixtureSQL(t *testing.T, pool *database.DB, statement string, arguments ...any) {
	t.Helper()
	if _, err := pool.Pool().Exec(schemaContext(t), statement, arguments...); err != nil {
		t.Fatalf("prepare isolated database case: %v", err)
	}
}
