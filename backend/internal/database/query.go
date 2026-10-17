package database

import (
	"context"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Exec executes one statement on a leased connection and always releases it.
func (database *DB) Exec(ctx context.Context, statement string, arguments ...any) (pgconn.CommandTag, error) {
	session, err := database.Acquire(ctx)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	defer session.Release(nil)
	return session.Exec(ctx, statement, arguments...)
}

// Query returns rows that own their lease until exhausted or closed. Callers must
// close rows when they stop before exhausting them, as required by pgx.
func (database *DB) Query(ctx context.Context, statement string, arguments ...any) (pgx.Rows, error) {
	session, err := database.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := session.Query(ctx, statement, arguments...)
	if err != nil {
		session.Release(nil)
		return nil, err
	}
	return &leasedRows{Rows: rows, session: session}, nil
}

// QueryRow releases its connection when Scan completes. Callers must always Scan.
func (database *DB) QueryRow(ctx context.Context, statement string, arguments ...any) pgx.Row {
	session, err := database.Acquire(ctx)
	if err != nil {
		return failedRow{err: err}
	}
	return &leasedRow{Row: session.QueryRow(ctx, statement, arguments...), session: session}
}

type failedRow struct{ err error }

func (row failedRow) Scan(...any) error { return row.err }

type leasedRows struct {
	pgx.Rows
	session  Session
	released sync.Once
}

func (rows *leasedRows) Close() {
	rows.released.Do(func() {
		rows.Rows.Close()
		rows.session.Release(nil)
	})
}

func (rows *leasedRows) Next() bool {
	if rows.Rows.Next() {
		return true
	}
	rows.Close()
	return false
}

type leasedRow struct {
	pgx.Row
	session Session
}

func (row *leasedRow) Scan(destinations ...any) error {
	defer row.session.Release(nil)
	return row.Row.Scan(destinations...)
}
