//go:build integration

package app_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func TestPostgresQueryFailuresUseThePublicHTTPEnvelope(t *testing.T) {
	for _, test := range []struct {
		name      string
		statement string
		arguments []any
		sqlState  string
		status    int
		code      string
		message   string
		details   map[string]any
	}{
		{
			name: "statement deadline", statement: "select 1 from pg_sleep(5)",
			sqlState: "57014",
			status: http.StatusServiceUnavailable, code: "DATABASE_READ_TIMEOUT",
			message: "The database read exceeded its deadline. Retry the request.",
			details: map[string]any{"retryable": true, "reason": "query_canceled", "sqlState": "57014"},
		},
		{
			name: "private database error", statement: "select $1::text::integer",
			arguments: []any{"private-database-payload"},
			sqlState: "22P02",
			status: http.StatusInternalServerError, code: "INTERNAL_ERROR",
			message: "The API could not complete the request.",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := testdb.New(t)
			options := fixture.Config()
			options.MaxConnections = 2
			options.QueryTimeout = 250 * time.Millisecond
			application, db := postgresApplication(t, options)
			var value int
			err := db.QueryRow(t.Context(), test.statement, test.arguments...).Scan(&value)
			var postgresError *pgconn.PgError
			if !errors.As(err, &postgresError) || postgresError.Code != test.sqlState {
				t.Fatalf("database query failure = %v, want PostgreSQL SQLSTATE %s", err, test.sqlState)
			}
			registerPostgresRead(application, db, "/database/value", "select 42")
			registerPostgresRead(application, db, "/database/failure", test.statement, test.arguments...)
			server := servePostgresApplication(t, application)
			requirePostgresReadiness(t, server, "ok", "ok")
			requirePostgresHTTPError(t, server.get(t, "/database/failure"), test.status, test.code, test.message, test.details)
			requirePostgresRead(t, server)
			requirePostgresReadiness(t, server, "ok", "ok")
		})
	}
}
