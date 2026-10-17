package schema

import (
	"context"
	"fmt"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

// Prepare accepts the frozen TS head or initializes an empty DB from the actual
// embedded dump, then applies numbered Go migrations. Unknown histories fail.
func Prepare(ctx context.Context, pool database.Acquirer, checkpointSchema string) error {
	baseline, err := Embedded()
	if err != nil {
		return err
	}
	return baseline.Prepare(ctx, pool, checkpointSchema)
}

// Prepare applies this captured baseline through the single transaction helper.
// Like TS migration startup, it is serialized with advisory lock 810001, and the
// complete operation has a 30-minute bound rather than a request query deadline.
func (b *Baseline) Prepare(ctx context.Context, pool database.Acquirer, checkpointSchema string) error {
	if len(b.head.ApplicationMigrations) == 0 {
		return ErrBaselineUnavailable
	}
	if err := validateCheckpointSchema(checkpointSchema); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	return database.WithTransaction(ctx, pool, func(ctx context.Context, sql database.Querier) error {
		settings, err := readBaselineSessionSettings(ctx, sql)
		if err != nil {
			return err
		}
		if _, err := sql.Exec(ctx, "set local statement_timeout = 0"); err != nil {
			return fmt.Errorf("set schema operation timeout: %w", err)
		}
		if _, err := sql.Exec(ctx, "select pg_advisory_xact_lock($1)", 810001); err != nil {
			return fmt.Errorf("lock application schema: %w", err)
		}
		if err := b.prepareApplication(ctx, sql); err != nil {
			return err
		}
		if err := restoreBaselineSessionSettings(ctx, sql, settings); err != nil {
			return err
		}
		if _, err := sql.Exec(ctx, "set local statement_timeout = 0"); err != nil {
			return fmt.Errorf("set schema operation timeout: %w", err)
		}
		if err := probeCheckpoints(ctx, sql, checkpointSchema); err != nil {
			return incompatibleCause("checkpoint schema is unavailable", err)
		}
		return b.applyMigrations(ctx, sql)
	}, database.TransactionOptions{})
}

func (b *Baseline) prepareApplication(ctx context.Context, sql database.Querier) error {
	var exists bool
	if err := sql.QueryRow(ctx, "select to_regclass('public.application_migrations') is not null").Scan(&exists); err != nil {
		return fmt.Errorf("inspect application migration ledger: %w", err)
	}
	if !exists {
		empty, err := emptyDatabase(ctx, sql)
		if err != nil {
			return err
		}
		if !empty {
			return fmt.Errorf("%w: a nonempty database has no application_migrations ledger", ErrIncompatible)
		}
		if b.sql == "" {
			return fmt.Errorf("%w: cannot initialize an empty database at source %s", ErrBaselineUnavailable, SourceCommit)
		}
		if _, err := sql.Exec(ctx, b.sql); err != nil {
			return fmt.Errorf("apply captured SQL baseline: %w", err)
		}
	}
	versions, err := applicationVersions(ctx, sql)
	if err != nil {
		return incompatibleCause("read application_migrations", err)
	}
	return b.CheckHead(versions)
}

func applicationVersions(ctx context.Context, sql database.Querier) ([]int64, error) {
	rows, err := sql.Query(ctx, "select version from public.application_migrations order by version")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var versions []int64
	for rows.Next() {
		var version int64
		if err := rows.Scan(&version); err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return versions, nil
}

func emptyDatabase(ctx context.Context, sql database.Querier) (bool, error) {
	// A database with a custom schema, relation, routine, or type is not empty,
	// even if it has no application tables. Default system namespaces are ignored.
	var empty bool
	err := sql.QueryRow(ctx, `
		select not exists (
		  select 1 from pg_namespace n
		  where n.nspname not in ('public', 'information_schema') and n.nspname !~ '^pg_'
		  union all
		  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
		  where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
		  union all
		  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
		  where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
		  union all
		  select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
		  where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
		)`).Scan(&empty)
	if err != nil {
		return false, fmt.Errorf("inspect empty database: %w", err)
	}
	return empty, nil
}
