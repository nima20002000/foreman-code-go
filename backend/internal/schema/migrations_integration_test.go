//go:build integration

package schema_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
)

// These are explicit later-migration fixtures. The TypeScript baseline is always
// restored from the actual embedded capture before either fixture can run.
const createSchemaObservation = `
	create table public.schema_observations (id bigint primary key, value text not null);
	insert into public.schema_observations (id, value) values (1, 'created');
`

const addSchemaObservation = "insert into public.schema_observations (id, value) values (2, 'added')"

type schemaObservation struct {
	id    int64
	value string
}

type recordedMigration struct {
	appliedMigration
	name     string
	checksum string
}

func TestNumberedMigrationsApplyOnceAcrossStartupAndRestart(t *testing.T) {
	pool, options := capturedDatabase(t)
	application := readBaselineState(t, pool)
	baseline := laterMigrations(t, pool, createSchemaObservation, addSchemaObservation)
	if err := baseline.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
		t.Fatalf("apply numbered migrations: %v", err)
	}
	expected := []schemaObservation{{id: 1, value: "created"}, {id: 2, value: "added"}}
	if !reflect.DeepEqual(readSchemaObservations(t, pool), expected) {
		t.Fatal("numbered migrations did not persist both observations")
	}
	history := readGoHistory(t, pool)
	if len(history) != 2 {
		t.Fatalf("expected two recorded Go migrations, got %d", len(history))
	}
	if err := baseline.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
		t.Fatalf("repeat numbered migrations: %v", err)
	}
	pool.Close()

	restarted := openSchemaPool(t, options)
	if err := baseline.Prepare(schemaContext(t), restarted, capturedCheckpointSchema); err != nil {
		t.Fatalf("restart numbered migrations: %v", err)
	}
	if !reflect.DeepEqual(readSchemaObservations(t, restarted), expected) ||
		!reflect.DeepEqual(readGoHistory(t, restarted), history) {
		t.Fatal("startup replayed or changed an already recorded Go migration")
	}
	requireBaselineUnchanged(t, restarted, application)
}

func TestNumberedMigrationsRejectChangedMissingOrUnknownHistory(t *testing.T) {
	cases := []struct {
		name       string
		corruption string
		scripts    []string
	}{
		{name: "changed embedded migration", scripts: []string{createSchemaObservation + "select 1;", addSchemaObservation}},
		{name: "missing embedded migration", scripts: []string{createSchemaObservation}},
		{name: "missing recorded migration", corruption: "delete from public.schema_migrations where version = 1"},
		{name: "unknown recorded migration", corruption: "update public.schema_migrations set version = 99 where version = 2"},
		{name: "altered recorded checksum", corruption: "update public.schema_migrations set checksum = 'altered' where version = 1"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			pool, _ := capturedDatabase(t)
			baseline := laterMigrations(t, pool, createSchemaObservation, addSchemaObservation)
			if err := baseline.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
				t.Fatalf("establish recorded Go migrations: %v", err)
			}
			if test.corruption != "" {
				executeFixtureSQL(t, pool, test.corruption)
			}
			if test.scripts != nil {
				baseline = laterMigrations(t, pool, test.scripts...)
			}
			application := readBaselineState(t, pool)
			history := readGoHistory(t, pool)
			observations := readSchemaObservations(t, pool)
			if err := baseline.Prepare(schemaContext(t), pool, capturedCheckpointSchema); !errors.Is(err, schema.ErrIncompatible) {
				t.Fatalf("expected refusal of incompatible Go history, got %v", err)
			}
			if !reflect.DeepEqual(readGoHistory(t, pool), history) ||
				!reflect.DeepEqual(readSchemaObservations(t, pool), observations) {
				t.Fatal("refused startup changed recorded Go history or its persisted results")
			}
			requireBaselineUnchanged(t, pool, application)
		})
	}
}

func TestFailedNumberedMigrationRollsBackHistoryAndPersistedChanges(t *testing.T) {
	pool, _ := capturedDatabase(t)
	application := readBaselineState(t, pool)
	failed := laterMigrations(t, pool, createSchemaObservation,
		"insert into public.schema_observations (id, value) values (1, 'duplicate')")
	err := failed.Prepare(schemaContext(t), pool, capturedCheckpointSchema)
	var conflict *pgconn.PgError
	if !errors.As(err, &conflict) || conflict.Code != "23505" {
		t.Fatalf("expected original duplicate-key failure, got %v", err)
	}
	if tableExists(t, pool, "public.schema_observations") || tableExists(t, pool, "public.schema_migrations") {
		t.Fatal("failed migration left partially applied schema or migration history")
	}
	requireBaselineUnchanged(t, pool, application)

	corrected := laterMigrations(t, pool, createSchemaObservation, addSchemaObservation)
	if err := corrected.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
		t.Fatalf("apply corrected migrations after rollback: %v", err)
	}
	if got := readSchemaObservations(t, pool); len(got) != 2 {
		t.Fatalf("expected corrected migrations to persist two observations, got %d", len(got))
	}
}

func laterMigrations(t *testing.T, pool *database.DB, scripts ...string) *schema.Baseline {
	t.Helper()
	history := readApplicationHistory(t, pool)
	validateCapturedHead(t, history)
	// Metadata comes from the real restored database and is checked against the
	// embedded head above. No TypeScript migration rows or baseline SQL are made.
	head, err := json.Marshal(map[string]any{
		"sourceCommit":          schema.SourceCommit,
		"applicationMigrations": migrationVersions(history),
	})
	if err != nil {
		t.Fatalf("encode current migration metadata: %v", err)
	}
	files := fstest.MapFS{"expected-head.json": &fstest.MapFile{Data: head}}
	for i, script := range scripts {
		name := fmt.Sprintf("migrations/%03d_schema_observations.sql", i+1)
		files[name] = &fstest.MapFile{Data: []byte(script)}
	}
	baseline, err := schema.Read(files)
	if err != nil {
		t.Fatalf("load later-migration fixtures: %v", err)
	}
	return baseline
}

func readSchemaObservations(t *testing.T, pool *database.DB) []schemaObservation {
	t.Helper()
	rows, err := pool.Pool().Query(schemaContext(t), "select id, value from public.schema_observations order by id")
	if err != nil {
		t.Fatalf("read persisted migration observations: %v", err)
	}
	defer rows.Close()
	var observations []schemaObservation
	for rows.Next() {
		var observation schemaObservation
		if err := rows.Scan(&observation.id, &observation.value); err != nil {
			t.Fatalf("read persisted migration observation: %v", err)
		}
		observations = append(observations, observation)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("finish persisted migration observations: %v", err)
	}
	return observations
}

func readGoHistory(t *testing.T, pool *database.DB) []recordedMigration {
	t.Helper()
	rows, err := pool.Pool().Query(schemaContext(t),
		"select version, name, checksum, applied_at from public.schema_migrations order by version")
	if err != nil {
		t.Fatalf("read persisted Go migration history: %v", err)
	}
	defer rows.Close()
	var history []recordedMigration
	for rows.Next() {
		var migration recordedMigration
		if err := rows.Scan(&migration.version, &migration.name, &migration.checksum, &migration.appliedAt); err != nil {
			t.Fatalf("read persisted Go migration record: %v", err)
		}
		migration.appliedAt = migration.appliedAt.UTC()
		history = append(history, migration)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("finish persisted Go migration history: %v", err)
	}
	return history
}
