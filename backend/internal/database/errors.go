// Package database owns PostgreSQL sessions, transaction control, and retry policy.
package database

import (
	"errors"
	"net"
	"reflect"
	"regexp"
	"syscall"
	"time"
)

var timeoutMessage = regexp.MustCompile(`(?i)time(d)? ?out`)
var connectionSQLState = regexp.MustCompile(`^08[A-Z0-9]{3}$`)

// PoolTimeoutError identifies expiration of a database acquisition, not a query.
type PoolTimeoutError struct{ Cause error }

func (err *PoolTimeoutError) Error() string {
	return "timeout exceeded when trying to connect"
}

func (err *PoolTimeoutError) Unwrap() error { return err.Cause }

// RetryDeadlineError keeps the failed operation and retry diagnostics together.
type RetryDeadlineError struct {
	Attempts int
	Elapsed  time.Duration
	Cause    error
}

func (err *RetryDeadlineError) Error() string {
	return "Database operation retry deadline exceeded."
}

func (err *RetryDeadlineError) Unwrap() error { return err.Cause }

func (err *RetryDeadlineError) FailureCode() string {
	return "DATABASE_RETRY_DEADLINE_EXCEEDED"
}

// IsPoolTimeout matches the acquisition failures that receive one read-only retry.
func IsPoolTimeout(err error) bool {
	if err == nil {
		return false
	}
	return err.Error() == "timeout exceeded when trying to connect" ||
		err.Error() == "Connection terminated due to connection timeout"
}

// IsTimeout follows the contracts failure predicate. Explicit cancellation (57014)
// is retryable only when PostgreSQL says it was a statement timeout.
func IsTimeout(err error) bool {
	var seen []error
	for err != nil {
		if seenError(seen, err) {
			return false
		}
		seen = append(seen, err)
		code := errorCode(err)
		if code == "57014" {
			return timeoutMessage.MatchString(err.Error())
		}
		if code == "DATABASE_READ_TIMEOUT" {
			return true
		}
		if code != "" && code != "GRAPH_TRANSACTION_FAILED" {
			return false
		}
		if err.Error() == "Query read timeout" || err.Error() == "Connection terminated due to connection timeout" {
			return true
		}
		err = errors.Unwrap(err)
	}
	return false
}

// IsTransactionConflict identifies serialization failures and deadlocks only.
func IsTransactionConflict(err error) bool {
	code := errorCode(err)
	return code == "40001" || code == "40P01"
}

func errorCode(err error) string {
	if coded, ok := err.(interface{ FailureCode() string }); ok {
		return coded.FailureCode()
	}
	if postgres, ok := err.(interface{ SQLState() string }); ok {
		return postgres.SQLState()
	}
	if number, ok := err.(syscall.Errno); ok {
		switch number {
		case syscall.ECONNREFUSED:
			return "ECONNREFUSED"
		case syscall.ECONNRESET:
			return "ECONNRESET"
		case syscall.EPIPE:
			return "EPIPE"
		case syscall.ETIMEDOUT:
			return "ETIMEDOUT"
		case syscall.ENETUNREACH:
			return "ENETUNREACH"
		case syscall.EHOSTUNREACH:
			return "EHOSTUNREACH"
		}
	}
	if dns, ok := err.(*net.DNSError); ok && dns.IsTemporary {
		return "EAI_AGAIN"
	}
	return ""
}

// IsTransientConnection follows database/socket causes unless a nearer error
// explicitly declares its failure class, as packages/contracts/src/failure.ts does.
func IsTransientConnection(err error) bool {
	var seen []error
	for err != nil {
		if seenError(seen, err) {
			return false
		}
		seen = append(seen, err)
		if classified, ok := err.(interface{ DeclaredFailureClass() string }); ok {
			switch classified.DeclaredFailureClass() {
			case "transient":
				return true
			case "permanent", "cancelled":
				return false
			}
		}
		if IsTimeout(err) || IsPoolTimeout(err) || isTransientCode(errorCode(err)) ||
			err.Error() == "Connection terminated unexpectedly" {
			return true
		}
		err = errors.Unwrap(err)
	}
	return false
}

func seenError(seen []error, candidate error) bool {
	for _, previous := range seen {
		if reflect.DeepEqual(previous, candidate) {
			return true
		}
	}
	return false
}

func isTransientCode(code string) bool {
	switch code {
	case "55P03", "40001", "40P01", "57P01", "57P02", "57P03", "53300", "DATABASE_RETRY_DEADLINE_EXCEEDED",
		"ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH":
		return true
	}
	return connectionSQLState.MatchString(code)
}
