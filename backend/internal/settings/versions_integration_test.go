//go:build integration

package settings_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
	"github.com/nima20002000/foreman-code-go/backend/internal/settings"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func settingsDatabase(t *testing.T) (*database.DB, config.Database) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	fixture := testdb.New(t)
	options := fixture.Config()
	options.MaxConnections = 4
	options.QueryTimeout = 30 * time.Second
	options.LockTimeout = 5 * time.Second
	pool := openSettingsDatabase(t, options)
	if err := schema.Prepare(t.Context(), pool, "langgraph"); err != nil {
		t.Fatalf("prepare fresh settings database from captured TypeScript baseline: %v", err)
	}
	return pool, options
}

func openSettingsDatabase(t *testing.T, options config.Database) *database.DB {
	t.Helper()
	pool, err := database.Open(t.Context(), options, nil)
	if err != nil {
		t.Fatalf("open disposable settings database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func requireSettingJSON(t *testing.T, actual json.RawMessage, expected string) {
	t.Helper()
	var got, want any
	if err := json.Unmarshal(actual, &got); err != nil {
		t.Fatalf("decode persisted setting: %v", err)
	}
	if err := json.Unmarshal([]byte(expected), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("persisted setting = %#v, want %#v", got, want)
	}
}

func requireSettingCount(t *testing.T, pool *database.DB, key string, expected int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(t.Context(), "select count(*) from application_setting_versions where setting_key = $1", key).Scan(&count); err != nil {
		t.Fatalf("read persisted setting history: %v", err)
	}
	if count != expected {
		t.Fatalf("persisted setting history count = %d, want %d", count, expected)
	}
}

func TestSettingVersionsSurviveReopenAndPreserveHistory(t *testing.T) {
	pool, options := settingsDatabase(t)
	store := settings.NewVersionStore(pool)
	key := "system-prompt"
	value, revision, version, err := store.Read(t.Context(), key, nil)
	if err != nil || value != nil || revision != 0 || version != nil {
		t.Fatalf("missing setting = %s, %d, %v, %v", value, revision, version, err)
	}
	requireSettingCount(t, pool, key, 0)
	first := `{"text":"Preserve Unicode: λ ✓\nKeep trailing spaces:  \n"}`
	expected := float64(0)
	revision, firstID, err := store.Write(t.Context(), key, json.RawMessage(first), &expected, nil)
	if err != nil || revision != 1 {
		t.Fatalf("first setting write = %d, %v", revision, err)
	}
	if !regexp.MustCompile(`^system-prompt-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(firstID) {
		t.Fatalf("setting version identity = %q", firstID)
	}
	second := `{"text":"Second version"}`
	revision, secondID, err := store.Write(t.Context(), key, json.RawMessage(second), nil, nil)
	if err != nil || revision != 2 || firstID == secondID {
		t.Fatalf("last-write-wins setting = %d, %q, %v", revision, secondID, err)
	}
	var retained json.RawMessage
	if err := pool.QueryRow(t.Context(), "select record from application_setting_versions where id = $1", firstID).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	requireSettingJSON(t, retained, first)
	requireSettingCount(t, pool, key, 2)
	pool.Close()
	reopened := settings.NewVersionStore(openSettingsDatabase(t, options))
	value, revision, version, err = reopened.Read(t.Context(), key, nil)
	if err != nil || revision != 2 || version == nil || *version != secondID {
		t.Fatalf("reopened setting metadata = %d, %v, %v", revision, version, err)
	}
	requireSettingJSON(t, value, second)
}

func TestSettingRevisionConflictLeavesCurrentAndHistoryUnchanged(t *testing.T) {
	pool, _ := settingsDatabase(t)
	store := settings.NewVersionStore(pool)
	key := "general-settings"
	first := `{"theme":"dark"}`
	_, firstID, err := store.Write(t.Context(), key, json.RawMessage(first), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	expected := float64(0)
	revision, versionID, err := store.Write(t.Context(), key, json.RawMessage(`{"theme":"light"}`), &expected, nil)
	failure, ok := domainerror.As(err)
	if !ok || failure.Code != "REVISION_CONFLICT" || failure.Status != 409 ||
		failure.Message != "Defaults changed since they were read." ||
		!reflect.DeepEqual(failure.Details, map[string]any{"currentRevision": int64(1)}) {
		t.Fatalf("revision conflict error = %#v", err)
	}
	if revision != 0 || versionID != "" {
		t.Fatalf("conflict returned an uncommitted version: %d %q", revision, versionID)
	}
	value, revision, current, err := store.Read(t.Context(), key, nil)
	if err != nil || revision != 1 || current == nil || *current != firstID {
		t.Fatalf("setting after conflict = %d %v %v", revision, current, err)
	}
	requireSettingJSON(t, value, first)
	requireSettingCount(t, pool, key, 1)
}

func TestSettingWritesShareSuppliedTransactionAndRollbackTogether(t *testing.T) {
	pool, _ := settingsDatabase(t)
	store := settings.NewVersionStore(pool)
	key := "operator-initial-prompt"
	rollback := errors.New("later command work failed")
	err := database.WithTransaction(t.Context(), pool, func(ctx context.Context, client database.Querier) error {
		for i := 0; i < 2; i++ {
			expected := float64(i)
			revision, versionID, err := store.Write(ctx, key, json.RawMessage(`{"text":"Uncommitted"}`), &expected, client)
			if err != nil || revision != int64(i+1) {
				t.Fatalf("supplied-transaction write = %d %v", revision, err)
			}
			value, readRevision, current, err := store.Read(ctx, key, client)
			if err != nil || readRevision != revision || current == nil || *current != versionID {
				t.Fatalf("supplied-transaction readback = %d %v %v", readRevision, current, err)
			}
			requireSettingJSON(t, value, `{"text":"Uncommitted"}`)
		}
		outside, revision, version, err := store.Read(ctx, key, nil)
		if err != nil || outside != nil || revision != 0 || version != nil {
			t.Fatalf("uncommitted setting escaped transaction: %s %d %v %v", outside, revision, version, err)
		}
		return rollback
	}, database.TransactionOptions{})
	if !errors.Is(err, rollback) {
		t.Fatalf("transaction failure = %v", err)
	}
	value, revision, version, err := store.Read(t.Context(), key, nil)
	if err != nil || value != nil || revision != 0 || version != nil {
		t.Fatalf("rolled-back setting = %s %d %v %v", value, revision, version, err)
	}
	requireSettingCount(t, pool, key, 0)
	expected := float64(0)
	if revision, _, err := store.Write(t.Context(), key, json.RawMessage(`{"text":"Committed"}`), &expected, nil); err != nil || revision != 1 {
		t.Fatalf("write after rollback = %d %v", revision, err)
	}
}

func TestConcurrentSettingCreatesHaveOneRevisionWinner(t *testing.T) {
	pool, _ := settingsDatabase(t)
	store := settings.NewVersionStore(pool)
	key := "general-settings"
	var ready sync.WaitGroup
	ready.Add(2)
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			ready.Done()
			<-start
			expected := float64(0)
			_, _, err := store.Write(t.Context(), key, json.RawMessage(`{"theme":"light"}`), &expected, nil)
			results <- err
		}()
	}
	ready.Wait()
	close(start)
	var passed, conflicted int
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			passed++
		} else if failure, ok := domainerror.As(err); ok && failure.Code == "REVISION_CONFLICT" {
			conflicted++
		} else {
			t.Fatalf("concurrent setting write failed: %v", err)
		}
	}
	if passed != 1 || conflicted != 1 {
		t.Fatalf("concurrent setting results = %d successes, %d revision conflicts", passed, conflicted)
	}
	requireSettingCount(t, pool, key, 1)
	value, revision, version, err := store.Read(t.Context(), key, nil)
	if err != nil || revision != 1 || version == nil {
		t.Fatalf("concurrent setting readback = %d %v %v", revision, version, err)
	}
	requireSettingJSON(t, value, `{"theme":"light"}`)
}

func TestSettingWriteCancellationDoesNotPersistAVersion(t *testing.T) {
	pool, _ := settingsDatabase(t)
	store := settings.NewVersionStore(pool)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	revision, versionID, err := store.Write(ctx, "general-settings", json.RawMessage(`{"theme":"light"}`), nil, nil)
	if !errors.Is(err, context.Canceled) || revision != 0 || versionID != "" {
		t.Fatalf("canceled write = %d %q %v", revision, versionID, err)
	}
	requireSettingCount(t, pool, "general-settings", 0)
	expected := float64(0)
	if revision, _, err := store.Write(t.Context(), "general-settings", json.RawMessage(`{"theme":"dark"}`), &expected, nil); err != nil || revision != 1 {
		t.Fatalf("write after cancellation = %d %v", revision, err)
	}
}
