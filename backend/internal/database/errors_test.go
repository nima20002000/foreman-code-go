package database_test

import (
	"errors"
	"fmt"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

type classifiedFailure struct {
	code  string
	class string
	cause error
}

func (failure *classifiedFailure) Error() string                { return "classified failure" }
func (failure *classifiedFailure) Unwrap() error                { return failure.cause }
func (failure *classifiedFailure) FailureCode() string          { return failure.code }
func (failure *classifiedFailure) DeclaredFailureClass() string { return failure.class }

func TestDatabaseTimeoutDistinguishesTimeoutFromCancellation(t *testing.T) {
	tests := []struct {
		name    string
		failure error
		want    bool
	}{
		{"statement timeout", &pgconn.PgError{Code: "57014", Message: "canceling statement due to statement timeout"}, true},
		{"explicit cancellation", &pgconn.PgError{Code: "57014", Message: "canceling statement due to user request"}, false},
		{"client timeout", &database.ReadTimeoutError{}, true},
		{"pool acquisition", &database.PoolTimeoutError{}, false},
		{"untyped wrapper", fmt.Errorf("operation failed: %w", &database.ReadTimeoutError{}), true},
		{"graph wrapper", &classifiedFailure{code: "GRAPH_TRANSACTION_FAILED", cause: &database.ReadTimeoutError{}}, true},
		{"different coded failure", &classifiedFailure{code: "INVALID_INPUT", cause: &database.ReadTimeoutError{}}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if result := database.IsTimeout(test.failure); result != test.want {
				t.Fatalf("IsTimeout() = %v, want %v", result, test.want)
			}
		})
	}
}

func TestTransientDatabaseFailureHonorsTheNearestExplicitClass(t *testing.T) {
	transient := &pgconn.PgError{Code: "53300", Message: "too many clients"}
	if !database.IsTransientConnection(transient) || !database.IsTransientConnection(fmt.Errorf("dial failed: %w", syscall.ECONNREFUSED)) {
		t.Fatal("Transient database or socket error was not recognized")
	}
	for _, class := range []string{"permanent", "cancelled"} {
		if database.IsTransientConnection(&classifiedFailure{class: class, cause: transient}) {
			t.Fatalf("The explicit %s class was overridden by a cause", class)
		}
	}
	if !database.IsTransientConnection(&classifiedFailure{class: "transient", cause: errors.New("unknown")}) {
		t.Fatal("An explicit transient class was ignored")
	}
}

func TestDatabaseFailureCauseCyclesTerminate(t *testing.T) {
	cycle := &classifiedFailure{}
	cycle.cause = cycle
	if database.IsTimeout(cycle) || database.IsTransientConnection(cycle) {
		t.Fatal("An undecided cause cycle must not become retryable")
	}
}
