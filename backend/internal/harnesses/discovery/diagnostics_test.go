//go:build linux || darwin

package discovery_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/discovery"
)

// These are compatibility guards for existing public errors, not new behavior.
func TestDiscoveryPublicErrorCompatibility(t *testing.T) {
	t.Run("fresh payload diagnostic", func(t *testing.T) {
		var cache discovery.PayloadFingerprintCache
		directory := t.TempDir()
		_, first := cache.Fingerprint(context.Background(), directory, nil)
		_, second := cache.Fingerprint(context.Background(), directory, nil)
		for _, err := range []error{first, second} {
			if err == nil || err.Error() != "Payload is not a file" || errors.Unwrap(err) != nil {
				t.Fatalf("payload diagnostic changed: %v", err)
			}
		}
		if first == second || errors.Is(first, second) {
			t.Fatal("separate payload failures acquired shared identity")
		}
	})
	t.Run("changed payload sentinel", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "payload")
		writeFixture(t, path, "original", 0600)
		before, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		writeFixture(t, path, "changed during inspection", 0600)
		var cache discovery.PayloadFingerprintCache
		_, err = cache.Fingerprint(context.Background(), path, before)
		if err != discovery.ErrPayloadChanged || !errors.Is(err, discovery.ErrPayloadChanged) {
			t.Fatalf("payload sentinel identity changed: %v", err)
		}
		if err.Error() != "Payload changed during fingerprinting" || errors.Unwrap(err) != nil {
			t.Fatalf("payload sentinel diagnostic changed: %v", err)
		}
		if !errors.Is(fmt.Errorf("inspect payload: %w", err), discovery.ErrPayloadChanged) {
			t.Fatal("wrapped payload sentinel no longer matches")
		}
	})
}
