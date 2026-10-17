//go:build integration

package schema_test

import (
	"testing"

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
