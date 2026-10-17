package schema_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
)

// These are small migration-history fixtures, not a captured production dump.
// The tests exercise public API results and database responses, never SQL text.
func fixtureBaseline(t *testing.T) *schema.Baseline {
	t.Helper()
	head, err := json.Marshal(map[string]any{
		"sourceCommit":          schema.SourceCommit,
		"applicationMigrations": []int64{1, 4, 42},
	})
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := schema.Read(fstest.MapFS{"expected-head.json": &fstest.MapFile{Data: head}})
	if err != nil {
		t.Fatal(err)
	}
	return baseline
}

func TestMigrationHeadRequiresEveryExpectedVersion(t *testing.T) {
	baseline := fixtureBaseline(t)
	for _, versions := range [][]int64{{1, 4, 42}, {42, 1, 4}} {
		if err := baseline.CheckHead(versions); err != nil {
			t.Fatalf("matching migration set was rejected: %v", err)
		}
	}
	cases := map[string][]int64{
		"older head":        {1, 4},
		"missing interior":  {1, 42},
		"unknown version":   {1, 4, 42, 43},
		"replaced version":  {1, 5, 42},
		"duplicate version": {1, 1, 42},
		"empty history":     nil,
	}
	for name, versions := range cases {
		t.Run(name, func(t *testing.T) {
			if err := baseline.CheckHead(versions); !errors.Is(err, schema.ErrIncompatible) {
				t.Fatalf("expected incompatible history, got %v", err)
			}
		})
	}
}

func TestEmptyDatabaseRequiresCapturedBaseline(t *testing.T) {
	client := &fixtureSession{rowResults: []bool{false, true}}
	err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph")
	if !errors.Is(err, schema.ErrBaselineUnavailable) {
		t.Fatalf("expected missing baseline, got %v", err)
	}
}

func TestNonemptyDatabaseWithoutLedgerIsRejected(t *testing.T) {
	client := &fixtureSession{rowResults: []bool{false, false}}
	err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph")
	if !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("expected incompatible database, got %v", err)
	}
}

func TestCurrentDatabaseIsAcceptedWithoutDump(t *testing.T) {
	client := &fixtureSession{
		rowResults: []bool{true, false},
		results:    []queryResult{{rows: versionRows(1, 4, 42)}, {rows: &fixtureRows{}}},
	}
	if err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph"); err != nil {
		t.Fatalf("current database was rejected: %v", err)
	}
}

func TestCurrentDatabaseStillRequiresCheckpointTables(t *testing.T) {
	missing := errors.New("checkpoint relation is unavailable")
	client := &fixtureSession{
		rowResults: []bool{true},
		results:    []queryResult{{rows: versionRows(1, 4, 42)}, {err: missing}},
	}
	err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph")
	if !errors.Is(err, schema.ErrIncompatible) || !errors.Is(err, missing) {
		t.Fatalf("expected incompatible checkpoint schema and original error, got %v", err)
	}
}

func TestStartupErrorsPreserveRetryCauses(t *testing.T) {
	stages := []struct {
		name           string
		rowResults     []bool
		completedReads int
	}{
		{name: "application history", rowResults: []bool{true}},
		{name: "checkpoint tables", rowResults: []bool{true}, completedReads: 1},
		{name: "Go history", rowResults: []bool{true, true}, completedReads: 2},
	}
	causes := []struct {
		name    string
		err     error
		timeout bool
	}{
		{name: "query timeout", err: &database.ReadTimeoutError{Cause: context.DeadlineExceeded}, timeout: true},
		{name: "server starting", err: &pgconn.PgError{Code: "57P03", Message: "database system is starting up"}},
	}
	for _, stage := range stages {
		for _, cause := range causes {
			t.Run(stage.name+"/"+cause.name, func(t *testing.T) {
				reads := []queryResult{{rows: versionRows(1, 4, 42)}, {rows: &fixtureRows{}}}
				client := &fixtureSession{
					rowResults: stage.rowResults,
					results:    append(reads[:stage.completedReads], queryResult{err: cause.err}),
				}
				err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph")
				if !errors.Is(err, schema.ErrIncompatible) || !errors.Is(err, cause.err) {
					t.Fatalf("expected incompatible database and original cause, got %v", err)
				}
				if !database.IsTransientConnection(err) {
					t.Fatalf("startup failure lost its retryable cause: %v", err)
				}
				if database.IsTimeout(err) != cause.timeout {
					t.Fatalf("startup failure changed timeout classification: %v", err)
				}
			})
		}
	}
}

func TestPartiallyMigratedDatabaseIsRejected(t *testing.T) {
	client := &fixtureSession{
		rowResults: []bool{true},
		results:    []queryResult{{rows: versionRows(1, 42)}},
	}
	err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph")
	if !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("expected incompatible database, got %v", err)
	}
}

func TestUnknownGoMigrationIsRejected(t *testing.T) {
	client := &fixtureSession{
		rowResults: []bool{true, true},
		results: []queryResult{
			{rows: versionRows(1, 4, 42)},
			{rows: &fixtureRows{}},
			{rows: &fixtureRows{values: [][]any{{int64(9), "unknown", "unrecognized"}}}},
		},
	}
	err := fixtureBaseline(t).Prepare(context.Background(), fixturePool{client}, "langgraph")
	if !errors.Is(err, schema.ErrIncompatible) {
		t.Fatalf("expected incompatible Go history, got %v", err)
	}
}

func TestCheckpointProbeAllowsEmptyTables(t *testing.T) {
	client := &fixtureSession{results: []queryResult{{rows: &fixtureRows{}}}}
	if err := schema.CheckpointProbe(fixturePool{client}, "langgraph").Ping(context.Background()); err != nil {
		t.Fatalf("empty checkpoint tables were rejected: %v", err)
	}
}

func TestCheckpointProbePropagatesDatabaseFailure(t *testing.T) {
	missing := errors.New("checkpoint table is unavailable")
	client := &fixtureSession{results: []queryResult{{err: missing}}}
	err := schema.CheckpointProbe(fixturePool{client}, "langgraph").Ping(context.Background())
	if !errors.Is(err, missing) {
		t.Fatalf("expected database failure, got %v", err)
	}
}

func TestCheckpointProbeReleasesWithCancellationAfterCleanup(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	cause := errors.New("readiness request ended during checkpoint cleanup")
	rows := &fixtureRows{onClose: func() { cancel(cause) }}
	client := &fixtureSession{results: []queryResult{{rows: rows}}}
	err := schema.CheckpointProbe(fixturePool{client}, "langgraph").Ping(ctx)
	if !errors.Is(err, cause) {
		t.Fatalf("expected cancellation cause after successful query, got %v", err)
	}
	if client.releases != 1 || !errors.Is(client.releaseCause, cause) {
		t.Fatalf("expected one release with cancellation cause, got %d releases with %v", client.releases, client.releaseCause)
	}
}

func TestCheckpointProbeRejectsInvalidSchemaName(t *testing.T) {
	for _, name := range []string{"", "LangGraph", "other.schema", "schema\"suffix"} {
		if err := schema.CheckpointProbe(fixturePool{}, name).Ping(context.Background()); err == nil {
			t.Fatalf("accepted invalid checkpoint schema %q", name)
		}
	}
}

type fixturePool struct{ client *fixtureSession }

func (p fixturePool) Acquire(ctx context.Context) (database.Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p.client == nil {
		return nil, errors.New("unexpected database acquisition")
	}
	return p.client, nil
}

type queryResult struct {
	rows pgx.Rows
	err  error
}

type fixtureSession struct {
	rowResults   []bool
	results      []queryResult
	releaseCause error
	releases     int
}

func (s *fixtureSession) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag(""), nil
}

func (s *fixtureSession) Query(context.Context, string, ...any) (pgx.Rows, error) {
	if len(s.results) == 0 {
		return nil, errors.New("unexpected database query")
	}
	result := s.results[0]
	s.results = s.results[1:]
	return result.rows, result.err
}

func (s *fixtureSession) QueryRow(context.Context, string, ...any) pgx.Row {
	return fixtureRow{session: s}
}

func (s *fixtureSession) Release(cause error) {
	s.releaseCause = cause
	s.releases++
}

type fixtureRow struct {
	session *fixtureSession
}

func (r fixtureRow) Scan(dest ...any) error {
	if len(dest) != 1 {
		return fmt.Errorf("expected one result destination, got %d", len(dest))
	}
	if values, ok := dest[0].(*[]string); ok {
		*values = []string{
			"30min", "5s", "0", "0", "UTF8", "on", `"$user", public`,
			"on", "content", "notice", "on", "", "heap",
		}
		return nil
	}
	value, ok := dest[0].(*bool)
	if !ok {
		return fmt.Errorf("unexpected result destination %T", dest[0])
	}
	if len(r.session.rowResults) == 0 {
		return errors.New("unexpected database inspection")
	}
	*value = r.session.rowResults[0]
	r.session.rowResults = r.session.rowResults[1:]
	return nil
}

type fixtureRows struct {
	pgx.Rows
	values  [][]any
	index   int
	onClose func()
}

func versionRows(versions ...int64) *fixtureRows {
	rows := &fixtureRows{}
	for _, version := range versions {
		rows.values = append(rows.values, []any{version})
	}
	return rows
}

func (r *fixtureRows) Next() bool {
	if r.index >= len(r.values) {
		return false
	}
	r.index++
	return true
}

func (r *fixtureRows) Scan(dest ...any) error {
	if r.index < 1 || r.index > len(r.values) || len(dest) != len(r.values[r.index-1]) {
		return errors.New("invalid fixture row read")
	}
	for i, value := range r.values[r.index-1] {
		switch target := dest[i].(type) {
		case *int64:
			*target = value.(int64)
		case *string:
			*target = value.(string)
		default:
			return fmt.Errorf("unexpected row destination %T", target)
		}
	}
	return nil
}

func (r *fixtureRows) Close() {
	if r.onClose != nil {
		callback := r.onClose
		r.onClose = nil
		callback()
	}
}

func (r *fixtureRows) Err() error { return nil }
