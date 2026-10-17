//go:build integration

package app_test

import (
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func TestPostgresCheckpointReadinessReportsFailureAndRecovery(t *testing.T) {
	fixture := testdb.New(t)
	options := fixture.Config()
	options.MaxConnections = 2
	application, db := postgresApplication(t, options)
	server := servePostgresApplication(t, application)
	requirePostgresReadiness(t, server, "ok", "ok")

	// Mutate only a real checkpoint table restored from the captured TS baseline.
	if _, err := db.Exec(t.Context(), "alter table langgraph.checkpoint_writes rename to checkpoint_writes_unavailable"); err != nil {
		t.Fatal(err)
	}
	requirePostgresReadiness(t, server, "ok", "unavailable")
	liveness := server.get(t, "/health/live")
	wantLive := map[string]any{"status": "ok", "service": "graphql-api"}
	if liveness.status != http.StatusOK || !reflect.DeepEqual(liveness.body, wantLive) {
		t.Fatalf("liveness during checkpoint failure = %d %#v", liveness.status, liveness.body)
	}
	if _, err := db.Exec(t.Context(), "alter table langgraph.checkpoint_writes_unavailable rename to checkpoint_writes"); err != nil {
		t.Fatal(err)
	}
	requirePostgresReadiness(t, server, "ok", "ok")
}

func TestPostgresPoolExhaustionIsUnavailableAndRecoversOverHTTP(t *testing.T) {
	fixture := testdb.New(t)
	options := fixture.Config()
	options.MaxConnections = 2
	options.ConnectionTimeout = 250 * time.Millisecond
	application, db := postgresApplication(t, options)
	registerPostgresRead(application, db, "/database/value", "select 42")
	server := servePostgresApplication(t, application)
	requirePostgresReadiness(t, server, "ok", "ok")
	requirePostgresRead(t, server)

	var held []database.Session
	t.Cleanup(func() {
		for _, session := range held {
			session.Release(nil)
		}
	})
	for range options.MaxConnections {
		session, err := db.Acquire(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, session)
	}
	requirePostgresReadiness(t, server, "unavailable", "unavailable")
	requirePostgresHTTPError(t, server.get(t, "/database/value"), http.StatusServiceUnavailable,
		"DATABASE_BUSY", "A database connection is temporarily unavailable. Retry shortly with the same commandId if supplied.",
		map[string]any{"retryable": true, "newCommandRequired": false})

	for _, session := range held {
		session.Release(nil)
	}
	held = nil
	requirePostgresReadiness(t, server, "ok", "ok")
	requirePostgresRead(t, server)
}
