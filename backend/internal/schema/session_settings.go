package schema

import (
	"context"
	"fmt"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

// The captured pg_dump changes these settings for its entire session.
var baselineSettingNames = []string{
	"statement_timeout",
	"lock_timeout",
	"idle_in_transaction_session_timeout",
	"transaction_timeout",
	"client_encoding",
	"standard_conforming_strings",
	"search_path",
	"check_function_bodies",
	"xmloption",
	"client_min_messages",
	"row_security",
	"default_tablespace",
	"default_table_access_method",
}

func readBaselineSessionSettings(ctx context.Context, sql database.Querier) ([]string, error) {
	var values []string
	err := sql.QueryRow(ctx, `
		select array_agg(pg_catalog.current_setting(name) order by ordinal)
		from pg_catalog.unnest($1::text[]) with ordinality as settings(name, ordinal)
	`, baselineSettingNames).Scan(&values)
	if err != nil {
		return nil, fmt.Errorf("read schema session settings: %w", err)
	}
	return values, nil
}

func restoreBaselineSessionSettings(ctx context.Context, sql database.Querier, values []string) error {
	for i, name := range baselineSettingNames {
		if _, err := sql.Exec(ctx, "select pg_catalog.set_config($1, $2, false)", name, values[i]); err != nil {
			return fmt.Errorf("restore schema session setting %s: %w", name, err)
		}
	}
	return nil
}
