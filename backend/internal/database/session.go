package database

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type poolSession struct {
	connection   *pgxpool.Conn
	queryTimeout time.Duration
	logger       *slog.Logger
	released     sync.Once
}

func (session *poolSession) Exec(ctx context.Context, statement string, arguments ...any) (pgconn.CommandTag, error) {
	queryContext, cancel := context.WithTimeout(ctx, session.queryTimeout)
	defer cancel()
	result, err := session.connection.Exec(queryContext, statement, arguments...)
	return result, queryError(ctx, queryContext, err)
}

func (session *poolSession) Query(ctx context.Context, statement string, arguments ...any) (pgx.Rows, error) {
	queryContext, cancel := context.WithTimeout(ctx, session.queryTimeout)
	rows, err := session.connection.Query(queryContext, statement, arguments...)
	if err != nil {
		failure := queryError(ctx, queryContext, err)
		cancel()
		return nil, failure
	}
	return &deadlineRows{Rows: rows, parent: ctx, query: queryContext, cancel: cancel}, nil
}

func (session *poolSession) QueryRow(ctx context.Context, statement string, arguments ...any) pgx.Row {
	queryContext, cancel := context.WithTimeout(ctx, session.queryTimeout)
	return &deadlineRow{
		Row:    session.connection.QueryRow(queryContext, statement, arguments...),
		parent: ctx, query: queryContext, cancel: cancel,
	}
}

func (session *poolSession) Release(cause error) {
	session.released.Do(func() {
		if cause == nil {
			session.connection.Release()
			return
		}
		connection := session.connection.Hijack()
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := connection.Close(cleanup); err != nil {
			session.logger.Error("Failed to close discarded database connection", "component", "db", "err", err)
		}
	})
}

// ReadTimeoutError distinguishes a client query deadline from caller cancellation.
type ReadTimeoutError struct{ Cause error }

func (err *ReadTimeoutError) Error() string       { return "Query read timeout" }
func (err *ReadTimeoutError) Unwrap() error       { return err.Cause }
func (err *ReadTimeoutError) FailureCode() string { return "DATABASE_READ_TIMEOUT" }

func queryError(parent, query context.Context, err error) error {
	if err == nil {
		return nil
	}
	if cancellation := context.Cause(parent); cancellation != nil {
		return cancellation
	}
	if errors.Is(context.Cause(query), context.DeadlineExceeded) {
		return &ReadTimeoutError{Cause: err}
	}
	return err
}

type deadlineRows struct {
	pgx.Rows
	parent context.Context
	query  context.Context
	cancel context.CancelFunc
}

func (rows *deadlineRows) Close() {
	rows.Rows.Close()
	rows.cancel()
}

func (rows *deadlineRows) Next() bool {
	if rows.Rows.Next() {
		return true
	}
	rows.Close()
	return false
}

func (rows *deadlineRows) Err() error {
	return queryError(rows.parent, rows.query, rows.Rows.Err())
}

type deadlineRow struct {
	pgx.Row
	parent context.Context
	query  context.Context
	cancel context.CancelFunc
}

func (row *deadlineRow) Scan(destinations ...any) error {
	defer row.cancel()
	return queryError(row.parent, row.query, row.Row.Scan(destinations...))
}
