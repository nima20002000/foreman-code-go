//go:build integration

package devices_test

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
	"github.com/nima20002000/foreman-code-go/backend/internal/testdb"
)

func freshIdentityDatabase(t *testing.T) (*database.DB, config.Database, string) {
	t.Helper()
	fixture := testdb.New(t)
	options := fixture.Config()
	options.MaxConnections = 12
	options.QueryTimeout = 30 * time.Minute
	pool := openIdentityDatabase(t, options)
	if err := schema.Prepare(t.Context(), pool, "langgraph"); err != nil {
		t.Fatalf("prepare the disposable captured database: %v", err)
	}
	var mainID string
	if err := pool.QueryRow(t.Context(), "select id::text from application_installation where singleton=true").Scan(&mainID); err != nil {
		t.Fatalf("read the disposable installation: %v", err)
	}
	return pool, options, mainID
}

func openIdentityDatabase(t *testing.T, options config.Database) *database.DB {
	t.Helper()
	pool, err := database.OpenPool(t.Context(), options, "device-identity-integration", nil)
	if err != nil {
		t.Fatalf("open the disposable identity database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestMainIdentityConvergesConcurrentStartsAndSurvivesRestart(t *testing.T) {
	pool, options, mainID := freshIdentityDatabase(t)
	const starters = 12
	identities := make([]*devices.MainIdentity, starters)
	errorsByStart := make([]error, starters)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := range starters {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			identities[i], errorsByStart[i] = devices.LoadOrCreateMainIdentity(t.Context(), pool, mainID)
		}()
	}
	close(start)
	workers.Wait()
	for _, err := range errorsByStart {
		if err != nil {
			t.Fatalf("concurrent identity startup failed: %v", err)
		}
	}
	first := identities[0]
	for _, identity := range identities {
		if identity.MainID() != mainID || identity.PublicKey() != first.PublicKey() || identity.Fingerprint() != first.Fingerprint() {
			t.Fatal("concurrent starts returned different Main identities")
		}
	}
	message := []byte("proof retained across a main restart")
	before, err := first.Sign(message)
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	restarted := openIdentityDatabase(t, options)
	identity, err := devices.LoadOrCreateMainIdentity(t.Context(), restarted, mainID)
	if err != nil {
		t.Fatalf("restore Main identity after database-pool restart: %v", err)
	}
	after, err := identity.Sign(message)
	if err != nil || identity.PublicKey() != first.PublicKey() || !bytes.Equal(before, after) {
		t.Fatalf("restart changed the persisted Main signing identity: %v", err)
	}
	if !devices.VerifyIdentitySignature(first.PublicKey(), message, after) {
		t.Fatal("a worker pinned to the previous identity cannot verify after restart")
	}
	var count int
	if err := restarted.QueryRow(t.Context(), "select count(*) from device_main_identity").Scan(&count); err != nil || count != 1 {
		t.Fatalf("expected one persisted identity, got %d (%v)", count, err)
	}
}

func TestMainIdentityRejectsWrongInstallationWithoutWriting(t *testing.T) {
	pool, _, mainID := freshIdentityDatabase(t)
	wrongMain := "ffffffff-ffff-4fff-8fff-ffffffffffff"
	if mainID == wrongMain {
		wrongMain = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	}
	_, err := devices.LoadOrCreateMainIdentity(t.Context(), pool, wrongMain)
	public, ok := domainerror.As(err)
	if !ok || public.Code != "wrong_main" || public.Status != 403 || public.Message != "Device access rejected: wrong_main" {
		t.Fatalf("unexpected wrong-main public failure: %v", err)
	}
	var count int
	if err := pool.QueryRow(t.Context(), "select count(*) from device_main_identity").Scan(&count); err != nil || count != 0 {
		t.Fatalf("wrong-main request persisted an identity: count=%d, error=%v", count, err)
	}
}

func TestMainIdentityRefusesCorruptionWithoutReplacingPersistedRecord(t *testing.T) {
	pool, _, mainID := freshIdentityDatabase(t)
	identity, err := devices.LoadOrCreateMainIdentity(t.Context(), pool, mainID)
	if err != nil {
		t.Fatal(err)
	}
	var original []byte
	if err := pool.QueryRow(t.Context(), "select record from device_main_identity where main_id=$1", mainID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	other, err := devices.GenerateIdentityKey()
	if err != nil {
		t.Fatal(err)
	}
	otherPrivate, err := other.PrivateKeyPEM()
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		field string
		value string
	}{
		{name: "different main", field: "mainId", value: "ffffffff-ffff-4fff-8fff-ffffffffffff"},
		{name: "changed fingerprint", field: "publicKeyFingerprint", value: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"},
		{name: "changed public key", field: "publicKey", value: other.PublicKey()},
		{name: "changed private key", field: "privateKey", value: otherPrivate},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := pool.Exec(t.Context(), "update device_main_identity set record=$2 where main_id=$1", mainID, original); err != nil {
				t.Fatal(err)
			}
			var corrupt []byte
			err := pool.QueryRow(t.Context(), `update device_main_identity set record=jsonb_set(record,array[$2]::text[],to_jsonb($3::text))
				where main_id=$1 returning record`, mainID, test.field, test.value).Scan(&corrupt)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := devices.LoadOrCreateMainIdentity(t.Context(), pool, mainID); !errors.Is(err, devices.ErrCorruptMainIdentity) {
				t.Fatalf("expected explicit corruption refusal, got %v", err)
			}
			var after []byte
			if err := pool.QueryRow(t.Context(), "select record from device_main_identity where main_id=$1", mainID).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(after, corrupt) {
				t.Fatal("refused startup replaced the corrupt persisted record")
			}
		})
	}
	if identity.MainID() != mainID {
		t.Fatal("the retained identity changed after a refused startup")
	}
}

func TestMainIdentityPropagatesCallerCancellationWithoutCreatingIdentity(t *testing.T) {
	pool, _, mainID := freshIdentityDatabase(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := devices.LoadOrCreateMainIdentity(ctx, pool, mainID); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected caller cancellation, got %v", err)
	}
	var count int
	if err := pool.QueryRow(t.Context(), "select count(*) from device_main_identity").Scan(&count); err != nil || count != 0 {
		t.Fatalf("canceled caller created identity: count=%d, error=%v", count, err)
	}
}
