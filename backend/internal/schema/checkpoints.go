package schema

import (
	"context"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

var checkpointSchemaName = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// CheckpointReadiness checks the same tables used by TS startup and readiness.
type CheckpointReadiness struct {
	pool   database.Acquirer
	schema string
}

// CheckpointProbe constructs a configured checkpoint readiness probe. Ping checks
// the identifier and uses the caller's bounded context for acquisition and SQL.
func CheckpointProbe(pool database.Acquirer, schemaName string) *CheckpointReadiness {
	return &CheckpointReadiness{pool: pool, schema: schemaName}
}

// Ping succeeds for empty checkpoint tables, but never for missing tables.
func (p *CheckpointReadiness) Ping(ctx context.Context) (err error) {
	if err := validateCheckpointSchema(p.schema); err != nil {
		return err
	}
	client, err := p.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire checkpoint readiness connection: %w", err)
	}
	defer func() { client.Release(err) }()
	return probeCheckpoints(ctx, client, p.schema)
}

func validateCheckpointSchema(schema string) error {
	if !checkpointSchemaName.MatchString(schema) {
		return fmt.Errorf("checkpoint schema %q must be a lowercase PostgreSQL identifier", schema)
	}
	return nil
}

func probeCheckpoints(ctx context.Context, sql database.Querier, schema string) error {
	identifier := pgx.Identifier{schema}.Sanitize()
	rows, err := sql.Query(ctx, "select 1 from "+identifier+".checkpoints "+
		"left join "+identifier+".checkpoint_blobs on false "+
		"left join "+identifier+".checkpoint_writes on false limit 1")
	if err != nil {
		return fmt.Errorf("query checkpoint tables: %w", err)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read checkpoint tables: %w", err)
	}
	return context.Cause(ctx)
}
