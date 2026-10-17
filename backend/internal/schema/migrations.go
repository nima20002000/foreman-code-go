package schema

import (
	"context"
	"fmt"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func (b *Baseline) applyMigrations(ctx context.Context, sql database.Querier) error {
	var exists bool
	if err := sql.QueryRow(ctx, "select to_regclass('public.schema_migrations') is not null").Scan(&exists); err != nil {
		return fmt.Errorf("inspect Go migration ledger: %w", err)
	}
	var applied []migration
	if exists {
		var err error
		applied, err = readMigrations(ctx, sql)
		if err != nil {
			return incompatibleCause("read schema_migrations", err)
		}
	}
	if err := b.checkGoHistory(applied); err != nil {
		return err
	}
	if len(applied) == len(b.migrations) {
		return nil
	}
	if !exists {
		if _, err := sql.Exec(ctx, `create table public.schema_migrations (
			version bigint primary key,
			name text not null,
			checksum text not null,
			applied_at timestamptz not null default now()
		)`); err != nil {
			return fmt.Errorf("create Go migration ledger: %w", err)
		}
	}
	for _, migration := range b.migrations[len(applied):] {
		if _, err := sql.Exec(ctx, migration.sql); err != nil {
			return fmt.Errorf("apply schema migration %s: %w", migration.name, err)
		}
		if _, err := sql.Exec(ctx,
			"insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)",
			migration.version, migration.name, migration.checksum); err != nil {
			return fmt.Errorf("record schema migration %s: %w", migration.name, err)
		}
	}
	return nil
}

func (b *Baseline) checkGoHistory(applied []migration) error {
	if len(applied) > len(b.migrations) {
		return fmt.Errorf("%w: schema_migrations contains unknown versions", ErrIncompatible)
	}
	for i, previous := range applied {
		expected := b.migrations[i]
		if previous.version != expected.version || previous.name != expected.name || previous.checksum != expected.checksum {
			return fmt.Errorf("%w: schema migration %d does not match the embedded history", ErrIncompatible, previous.version)
		}
	}
	return nil
}

func readMigrations(ctx context.Context, sql database.Querier) ([]migration, error) {
	rows, err := sql.Query(ctx, "select version, name, checksum from public.schema_migrations order by version")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var migrations []migration
	for rows.Next() {
		var migration migration
		if err := rows.Scan(&migration.version, &migration.name, &migration.checksum); err != nil {
			return nil, err
		}
		migrations = append(migrations, migration)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return migrations, nil
}
