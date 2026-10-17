package database_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func TestStartupRetriesADatabaseThatIsStarting(t *testing.T) {
	attempts := 0
	value, err := database.RetryStartup(context.Background(), func(context.Context) (string, error) {
		attempts++
		if attempts == 1 {
			return "", &pgconn.PgError{Code: "57P03", Message: "database system is starting up"}
		}
		return "ready", nil
	}, retryOptions())
	if err != nil || value != "ready" || attempts != 2 {
		t.Fatalf("Startup did not recover: value=%q, attempts=%d, error=%v", value, attempts, err)
	}
}

func TestStartupDoesNotRetryUnrelatedDatabaseFailures(t *testing.T) {
	for _, code := range []string{"28P01", "42P01", "40P01"} {
		t.Run(code, func(t *testing.T) {
			failure := &pgconn.PgError{Code: code, Message: "database operation failed"}
			attempts := 0
			_, err := database.RetryStartup(context.Background(), func(context.Context) (int, error) {
				attempts++
				return 0, failure
			}, retryOptions())
			if err != failure || attempts != 1 {
				t.Fatalf("Unrelated startup failure retried: attempts=%d, error=%v", attempts, err)
			}
		})
	}
}
