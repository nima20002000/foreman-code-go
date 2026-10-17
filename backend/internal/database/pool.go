package database

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

const maximumQueryTimeout = time.Duration(2_147_483_647) * time.Millisecond

// Querier is the shared SQL port used by repositories and transaction callbacks.
type Querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Session owns one pooled connection. A non-nil release error discards the connection.
type Session interface {
	Querier
	Release(error)
}

// Acquirer keeps SQL belonging to a transaction on one connection.
type Acquirer interface {
	Acquire(context.Context) (Session, error)
}

// DB owns the application's pgx pool and its connection/read deadline policy.
type DB struct {
	pool              *pgxpool.Pool
	connectionTimeout time.Duration
	queryTimeout      time.Duration
	logger            *slog.Logger
}

// PoolConfig applies the same pool sizing and timeout policy as the TS API.
// This builds configuration only; it does not connect to a database.
func PoolConfig(options config.Database, applicationName string) (*pgxpool.Config, error) {
	if options.MaxConnections < 1 || options.ConnectionTimeout <= 0 || options.QueryTimeout <= 0 || options.LockTimeout < 0 {
		return nil, errors.New("database pool size and timeouts must be positive; lock timeout may be zero")
	}
	poolConfig, err := pgxpool.ParseConfig(options.ConnectionString)
	if err != nil {
		// Parse errors can contain the connection string, including its password.
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	poolConfig.MaxConns = options.MaxConnections
	poolConfig.MinConns = min(options.MaxConnections, 4)
	poolConfig.MaxConnIdleTime = time.Minute
	// The TS pool retains sessions without an age-based eviction policy.
	poolConfig.MaxConnLifetime = 0
	poolConfig.ConnConfig.ConnectTimeout = min(options.ConnectionTimeout, time.Second)
	poolConfig.ConnConfig.RuntimeParams["application_name"] = applicationName
	poolConfig.ConnConfig.RuntimeParams["statement_timeout"] = strconv.FormatInt(options.QueryTimeout.Milliseconds(), 10)
	if options.LockTimeout > 0 {
		poolConfig.ConnConfig.RuntimeParams["lock_timeout"] = strconv.FormatInt(options.LockTimeout.Milliseconds(), 10)
	}
	return poolConfig, nil
}

// Open constructs the application pool. Startup schema preparation and Ping remain
// explicit so readiness never reports success before initialization finishes.
func Open(ctx context.Context, options config.Database, logger *slog.Logger) (*DB, error) {
	return OpenPool(ctx, options, "graphql-api", logger)
}

// OpenPool applies the common policy to a dedicated migration, checkpoint, or
// dispatch pool. Each caller owns closing the returned pool.
func OpenPool(ctx context.Context, options config.Database, applicationName string, logger *slog.Logger) (*DB, error) {
	poolConfig, err := PoolConfig(options, applicationName)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("create database pool: %w", err)
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &DB{
		pool:              pool,
		connectionTimeout: min(options.ConnectionTimeout, time.Second),
		queryTimeout:      min(options.QueryTimeout+time.Second, maximumQueryTimeout),
		logger:            logger,
	}, nil
}

// Pool exposes pgx for driver-specific operations. Ordinary repositories use DB or
// the transaction Querier so they retain application acquisition/retry policy.
func (database *DB) Pool() *pgxpool.Pool { return database.pool }

// Close waits until all checked-out sessions have been released and closes the pool.
func (database *DB) Close() { database.pool.Close() }

// Acquire bounds each acquisition to one second at most and uses the active read
// scope's single retry. A connection acquired after cancellation is released unused.
func (database *DB) Acquire(ctx context.Context) (Session, error) {
	return AcquireConnection(ctx, func(ctx context.Context) (Session, error) {
		acquisition, cancel := context.WithTimeout(ctx, database.connectionTimeout)
		defer cancel()
		connection, err := database.pool.Acquire(acquisition)
		if err != nil {
			if cancellation := context.Cause(ctx); cancellation != nil {
				return nil, cancellation
			}
			if errors.Is(err, context.DeadlineExceeded) || pgconn.Timeout(err) {
				return nil, &PoolTimeoutError{Cause: err}
			}
			return nil, err
		}
		if cancellation := context.Cause(ctx); cancellation != nil {
			connection.Release()
			return nil, cancellation
		}
		return &poolSession{connection: connection, queryTimeout: database.queryTimeout, logger: database.logger}, nil
	})
}

// Ping completes cleanup before returning. Failed or cancelled probes discard their
// session rather than returning an in-flight query to the pool.
func (database *DB) Ping(ctx context.Context) error {
	session, err := database.Acquire(ctx)
	if err != nil {
		return err
	}
	if err := context.Cause(ctx); err != nil {
		session.Release(nil)
		return err
	}
	_, err = session.Exec(ctx, "select 1")
	if err == nil {
		err = context.Cause(ctx)
	}
	session.Release(err)
	return err
}
