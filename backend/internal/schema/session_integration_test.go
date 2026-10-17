//go:build integration

package schema_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func TestCapturedBaselinePreservesCallerSearchPath(t *testing.T) {
	for _, searchPath := range []string{"", `"caller namespace", public, pg_catalog`} {
		name := "default"
		if searchPath != "" {
			name = "custom"
		}
		t.Run(name, func(t *testing.T) {
			fixture := testdb.New(t)
			pool := openSchemaPool(t, fixture.Config())
			if searchPath != "" {
				executeFixtureSQL(t, pool, "select pg_catalog.set_config('search_path', $1, false)", searchPath)
			}
			beforePath, beforePID := readSessionNamespace(t, pool)
			if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
				t.Fatalf("initialize captured baseline: %v", err)
			}
			afterPath, afterPID := readSessionNamespace(t, pool)
			if afterPID != beforePID {
				t.Fatalf("startup replaced the caller's pooled session: before=%d after=%d", beforePID, afterPID)
			}
			if afterPath != beforePath {
				t.Errorf("startup changed caller search_path: before=%q after=%q", beforePath, afterPath)
			}
			state := readBaselineState(t, pool)
			var installation string
			if err := pool.Pool().QueryRow(schemaContext(t),
				"select id::text from application_installation where singleton = true").Scan(&installation); err != nil {
				t.Errorf("read unqualified persisted installation with search_path %q: %v", afterPath, err)
			} else if installation != state.installation {
				t.Errorf("unqualified installation differs from saved record: got=%q want=%q", installation, state.installation)
			}
			var localHuman string
			if err := pool.Pool().QueryRow(schemaContext(t),
				"select principal_id from local_human_principal where singleton = true").Scan(&localHuman); err != nil {
				t.Errorf("read unqualified persisted local human with search_path %q: %v", afterPath, err)
			} else if localHuman != state.localHuman {
				t.Errorf("unqualified local human differs from saved record: got=%q want=%q", localHuman, state.localHuman)
			}
		})
	}
}

func TestCapturedBaselineFailurePreservesCallerSearchPath(t *testing.T) {
	fixture := testdb.New(t)
	pool := openSchemaPool(t, fixture.Config())
	executeFixtureSQL(t, pool, "select pg_catalog.set_config('search_path', $1, false)",
		`"caller namespace", public, pg_catalog`)
	beforePath, beforePID := readSessionNamespace(t, pool)
	err := schema.Prepare(schemaContext(t), pool, "unavailable_checkpoints")
	var missingCheckpoint *pgconn.PgError
	if !errors.Is(err, schema.ErrIncompatible) || !errors.As(err, &missingCheckpoint) || missingCheckpoint.Code != "42P01" {
		t.Fatalf("expected incompatible schema with original missing-checkpoint cause, got %v", err)
	}
	afterPath, afterPID := readSessionNamespace(t, pool)
	if afterPath != beforePath || afterPID != beforePID {
		t.Fatalf("failed startup changed caller namespace: before=(%q,%d) after=(%q,%d)",
			beforePath, beforePID, afterPath, afterPID)
	}
	if tableExists(t, pool, "public.application_migrations") || tableExists(t, pool, "public.application_installation") {
		t.Fatal("failed startup left captured baseline data behind")
	}
}

func TestCapturedBaselinePreservesCallerSessionSettings(t *testing.T) {
	fixture := testdb.New(t)
	pool := openSchemaPool(t, fixture.Config())
	executeFixtureSQL(t, pool, "set idle_in_transaction_session_timeout = '3min'")
	executeFixtureSQL(t, pool, "set transaction_timeout = '5min'")
	settings := []string{
		"statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "transaction_timeout",
		"client_encoding", "standard_conforming_strings", "search_path", "check_function_bodies",
		"xmloption", "client_min_messages", "row_security", "default_tablespace", "default_table_access_method",
	}
	before := make(map[string]string, len(settings))
	for _, name := range settings {
		before[name] = readSessionSetting(t, pool, name)
	}
	_, beforePID := readSessionNamespace(t, pool)
	if err := schema.Prepare(schemaContext(t), pool, capturedCheckpointSchema); err != nil {
		t.Fatalf("initialize captured baseline: %v", err)
	}
	_, afterPID := readSessionNamespace(t, pool)
	if afterPID != beforePID {
		t.Fatalf("startup replaced the caller's pooled session: before=%d after=%d", beforePID, afterPID)
	}
	for _, name := range settings {
		if after := readSessionSetting(t, pool, name); after != before[name] {
			t.Errorf("startup changed caller %s: before=%q after=%q", name, before[name], after)
		}
	}
}

func readSessionSetting(t *testing.T, pool *database.DB, name string) string {
	t.Helper()
	var value string
	if err := pool.Pool().QueryRow(schemaContext(t), "select pg_catalog.current_setting($1)", name).Scan(&value); err != nil {
		t.Fatalf("read caller %s: %v", name, err)
	}
	return value
}

func readSessionNamespace(t *testing.T, pool *database.DB) (string, int) {
	t.Helper()
	var searchPath string
	var backendPID int
	if err := pool.Pool().QueryRow(schemaContext(t),
		"select current_setting('search_path'), pg_backend_pid()").Scan(&searchPath, &backendPID); err != nil {
		t.Fatalf("read pooled session namespace: %v", err)
	}
	return searchPath, backendPID
}
