//go:build integration

package schema_test

import (
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func TestCapturedBaselinePreservesStateAcrossStartupAndRestart(t *testing.T) {
	pool, options := capturedDatabase(t)
	before := readBaselineState(t, pool)
	if err := pool.Pool().QueryRow(schemaContext(t), `
		update public.application_installation set id = gen_random_uuid()
		where singleton = true returning id::text`).Scan(&before.installation); err != nil {
		t.Fatalf("change disposable installation identity: %v", err)
	}
	if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
		t.Fatalf("repeat startup rejected the current database: %v", err)
	}
	requireBaselineUnchanged(t, pool, before)
	pool.Close()

	restarted := openSchemaPool(t, options)
	if err := schema.Prepare(schemaContext(t), restarted, capturedCheckpointSchema); err != nil {
		t.Fatalf("restart rejected the current database: %v", err)
	}
	requireBaselineUnchanged(t, restarted, before)
	if err := schema.CheckpointProbe(restarted, capturedCheckpointSchema).Ping(schemaContext(t)); err != nil {
		t.Fatalf("checkpoint tables were not ready after restart: %v", err)
	}
}

func TestStartupRejectsUnknownNonemptyDatabaseWithoutChangingIt(t *testing.T) {
	fixture := testdb.New(t)
	pool := openSchemaPool(t, fixture.Config())
	executeFixtureSQL(t, pool, "create table public.schema_observations (value text not null)")
	executeFixtureSQL(t, pool, "insert into public.schema_observations (value) values ('existing state')")
	if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("expected refusal of unknown nonempty database, got %v", err)
	}
	var value string
	if err := pool.Pool().QueryRow(schemaContext(t), "select value from public.schema_observations").Scan(&value); err != nil {
		t.Fatalf("read original persisted state: %v", err)
	}
	if value != "existing state" || tableExists(t, pool, "public.application_migrations") {
		t.Fatal("refused startup changed the unknown database")
	}
}

func TestStartupRejectsIncompleteOrAlteredApplicationHistory(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*testing.T, []appliedMigration) (string, []any)
	}{
		{
			name: "older head",
			mutate: func(t *testing.T, history []appliedMigration) (string, []any) {
				return "delete from public.application_migrations where version = $1", []any{history[len(history)-1].version}
			},
		},
		{
			name: "missing interior version",
			mutate: func(t *testing.T, history []appliedMigration) (string, []any) {
				if len(history) < 3 {
					t.Fatal("captured history has no interior migration to remove")
				}
				return "delete from public.application_migrations where version = $1", []any{history[len(history)/2].version}
			},
		},
		{
			name: "replaced version",
			mutate: func(t *testing.T, history []appliedMigration) (string, []any) {
				return "update public.application_migrations set version = $1 where version = $2",
					[]any{history[len(history)-1].version + 1, history[0].version}
			},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			pool, _ := capturedDatabase(t)
			history := readApplicationHistory(t, pool)
			statement, arguments := test.mutate(t, history)
			executeFixtureSQL(t, pool, statement, arguments...)
			before := readBaselineState(t, pool)
			if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); !errors.Is(err, schema.ErrIncompatible) {
				t.Fatalf("expected refusal of altered application history, got %v", err)
			}
			requireBaselineUnchanged(t, pool, before)
		})
	}
}

func TestStartupRejectsMissingApplicationLedgerWithoutReplacingIt(t *testing.T) {
	pool, _ := capturedDatabase(t)
	before := readBaselineState(t, pool)
	executeFixtureSQL(t, pool, "alter table public.application_migrations rename to unavailable_application_migrations")
	if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("expected refusal of missing application ledger, got %v", err)
	}
	if tableExists(t, pool, "public.application_migrations") {
		t.Fatal("refused startup recreated a missing migration ledger")
	}
	executeFixtureSQL(t, pool, "alter table public.unavailable_application_migrations rename to application_migrations")
	requireBaselineUnchanged(t, pool, before)
}

func TestStartupAndReadinessRejectMissingCapturedCheckpointTable(t *testing.T) {
	pool, _ := capturedDatabase(t)
	before := readBaselineState(t, pool)
	executeFixtureSQL(t, pool, "alter table langgraph.checkpoint_writes rename to unavailable_checkpoint_writes")
	if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("expected refusal of missing checkpoint table, got %v", err)
	}
	if err := schema.CheckpointProbe(pool, capturedCheckpointSchema).Ping(schemaContext(t)); err == nil {
		t.Fatal("readiness accepted a missing captured checkpoint table")
	}
	if tableExists(t, pool, "langgraph.checkpoint_writes") {
		t.Fatal("refused startup recreated a missing checkpoint table")
	}
	requireBaselineUnchanged(t, pool, before)
}
