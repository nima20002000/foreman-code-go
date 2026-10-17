// Package settings persists application settings for the generated-contract
// services. Storage records are opaque here; callers must parse values through
// the shared generated contracts before writing and after reading them.
package settings

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// VersionPool is the existing SQL/transaction port used by the setting store.
type VersionPool interface {
	database.Querier
	database.Acquirer
}

// VersionStore retains immutable application_setting_versions and the current
// application_settings pointer in one transaction. It does not implement HTTP
// or MCP DTOs, defaults, contract validation, authorization, or command replay.
type VersionStore struct {
	pool VersionPool
}

func NewVersionStore(pool VersionPool) *VersionStore {
	return &VersionStore{pool: pool}
}

// Read returns the persisted JSON and version metadata. Missing settings return
// nil, 0, nil so the generated-contract caller can apply its own parsed default.
// A supplied transaction remains owned by the caller.
func (store *VersionStore) Read(ctx context.Context, key string, supplied database.Querier) (json.RawMessage, int64, *string, error) {
	client := supplied
	if client == nil {
		client = store.pool
	}
	var record json.RawMessage
	var revision int64
	var versionID *string
	err := client.QueryRow(ctx,
		"select record, revision, current_version_id from application_settings where key = $1", key,
	).Scan(&record, &revision, &versionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, nil, nil
	}
	if err != nil {
		return nil, 0, nil, err
	}
	return record, revision, versionID, nil
}

// Write saves an already contract-validated value. expectedRevision preserves
// the frozen TS number boundary, including rejection of non-safe integers.
// Omission means last write wins; it still creates a new immutable version.
func (store *VersionStore) Write(ctx context.Context, key string, accepted json.RawMessage, expectedRevision *float64, supplied database.Querier) (int64, string, error) {
	if expectedRevision != nil && !validExpectedRevision(*expectedRevision) {
		return 0, "", domainerror.New("REVISION_INVALID", "Expected revision must be a nonnegative integer.", 400, nil)
	}
	var nextRevision int64
	var versionID string
	err := database.InTransaction(ctx, store.pool, supplied, func(ctx context.Context, client database.Querier) error {
		if _, err := client.Exec(ctx, "select pg_advisory_xact_lock(hashtext($1))", "setting:"+key); err != nil {
			return err
		}
		var revision int64
		err := client.QueryRow(ctx, "select revision from application_settings where key = $1 for update", key).Scan(&revision)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if expectedRevision != nil && float64(revision) != *expectedRevision {
			return domainerror.New("REVISION_CONFLICT", "Defaults changed since they were read.", 409,
				map[string]any{"currentRevision": revision})
		}
		nextRevision = revision + 1
		identity, err := versionUUID()
		if err != nil {
			return err
		}
		versionID = fmt.Sprintf("%s-v%d-%s", key, nextRevision, identity)
		if _, err := client.Exec(ctx,
			`insert into application_setting_versions (id, setting_key, version, record)
			 values ($1, $2, $3, $4::jsonb)`, versionID, key, nextRevision, string(accepted),
		); err != nil {
			return err
		}
		_, err = client.Exec(ctx,
			`insert into application_settings (key, record, revision, current_version_id, updated_at)
			 values ($1, $2::jsonb, 1, $3, now())
			 on conflict (key) do update set record = excluded.record,
			   revision = application_settings.revision + 1, current_version_id = excluded.current_version_id,
			   updated_at = excluded.updated_at`, key, string(accepted), versionID,
		)
		return err
	})
	if err != nil {
		return 0, "", err
	}
	return nextRevision, versionID, nil
}

func validExpectedRevision(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 9_007_199_254_740_991 && math.Trunc(value) == value
}

func versionUUID() (string, error) {
	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		return "", err
	}
	identity[6] = (identity[6] & 0x0f) | 0x40
	identity[8] = (identity[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", identity[:4], identity[4:6], identity[6:8], identity[8:10], identity[10:]), nil
}
