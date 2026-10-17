package domainerror

import (
	"errors"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

// DatabaseConnectionFailure redacts connection failures that occur before a request can execute.
func DatabaseConnectionFailure(err error) error {
	if _, ok := As(err); ok {
		return err
	}
	code := failureCode(err)
	var timeout *database.PoolTimeoutError
	if !database.IsPoolTimeout(err) && !errors.As(err, &timeout) && code != "53300" && code != "57P03" {
		return err
	}
	failure := New("DATABASE_BUSY",
		"A database connection is temporarily unavailable. Retry shortly with the same commandId if supplied.",
		503, map[string]any{"retryable": true, "newCommandRequired": false})
	failure.Cause = err
	return failure
}

// DatabaseReadFailure keeps read deadlines public while hiding SQL and persisted payloads.
func DatabaseReadFailure(err error) error {
	if _, ok := As(err); ok {
		return err
	}
	code := failureCode(err)
	readTimeout := code == "DATABASE_READ_TIMEOUT" || err != nil && err.Error() == "Query read timeout"
	if code != "57014" && code != "55P03" && !readTimeout {
		return err
	}
	details := map[string]any{"retryable": true}
	switch {
	case readTimeout:
		details["reason"] = "query_read_timeout"
	case code == "55P03":
		details["reason"] = "lock_timeout"
		details["sqlState"] = code
	default:
		details["reason"] = "query_canceled"
		details["sqlState"] = code
	}
	failure := New("DATABASE_READ_TIMEOUT", "The database read exceeded its deadline. Retry the request.", 503, details)
	failure.Cause = err
	return failure
}
