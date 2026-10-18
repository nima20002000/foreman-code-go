//go:build linux || darwin

package discovery_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/discovery"
)

func TestFingerprintFollowsAliasesAndRetargetedSymlinks(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	alias := filepath.Join(root, "alias")
	writeFixture(t, first, "original", 0600)
	writeFixture(t, second, "modified", 0600)
	if err := os.Symlink(first, alias); err != nil {
		t.Fatal(err)
	}
	var cache discovery.PayloadFingerprintCache
	for _, path := range []string{first, alias, first} {
		got, err := cache.Fingerprint(context.Background(), path, nil)
		if err != nil || got != bytesDigest("original") {
			t.Fatalf("alias bytes mismatch: digest=%q error=%v", got, err)
		}
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(second, alias); err != nil {
		t.Fatal(err)
	}
	got, err := cache.Fingerprint(context.Background(), alias, nil)
	if err != nil || got != bytesDigest("modified") {
		t.Fatalf("retargeted alias reused old bytes: digest=%q error=%v", got, err)
	}
}

func TestFingerprintDetectsSameSizeWritesWithRestoredMtime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "payload")
	writeFixture(t, path, "original", 0600)
	oldTime := time.Unix(1000, 0)
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	var cache discovery.PayloadFingerprintCache
	first, err := cache.Fingerprint(context.Background(), path, nil)
	if err != nil || first != bytesDigest("original") {
		t.Fatalf("original bytes mismatch: digest=%q error=%v", first, err)
	}
	writeFixture(t, path, "modified", 0600)
	if err := os.Chtimes(path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	got, err := cache.Fingerprint(context.Background(), path, nil)
	if err != nil || got != bytesDigest("modified") {
		t.Fatalf("same-size write reused old bytes: digest=%q error=%v", got, err)
	}
}

func TestFingerprintDetectsReplacementInodeWithEqualSizeAndMtime(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "payload")
	replacement := filepath.Join(root, "replacement")
	writeFixture(t, path, "original", 0600)
	writeFixture(t, replacement, "modified", 0600)
	oldTime := time.Unix(1000, 0)
	for _, name := range []string{path, replacement} {
		if err := os.Chtimes(name, oldTime, oldTime); err != nil {
			t.Fatal(err)
		}
	}
	var cache discovery.PayloadFingerprintCache
	if _, err := cache.Fingerprint(context.Background(), path, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	got, err := cache.Fingerprint(context.Background(), path, nil)
	if err != nil || got != bytesDigest("modified") {
		t.Fatalf("replacement inode reused old bytes: digest=%q error=%v", got, err)
	}
}

func TestFingerprintRejectsSupersededObservation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "payload")
	writeFixture(t, path, "original", 0600)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, path, "changed during inspection", 0600)
	var cache discovery.PayloadFingerprintCache
	if _, err := cache.Fingerprint(context.Background(), path, before); !errors.Is(err, discovery.ErrPayloadChanged) {
		t.Fatalf("superseded observation was accepted: %v", err)
	}
	got, err := cache.Fingerprint(context.Background(), path, nil)
	if err != nil || got != bytesDigest("changed during inspection") {
		t.Fatalf("rejected observation poisoned the cache: digest=%q error=%v", got, err)
	}
}

func TestFingerprintRejectsRemovedCachedFileAndDirectories(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "payload")
	writeFixture(t, path, "original", 0600)
	var cache discovery.PayloadFingerprintCache
	if _, err := cache.Fingerprint(context.Background(), path, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Fingerprint(context.Background(), path, nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing cached file returned old bytes: %v", err)
	}
	if _, err := cache.Fingerprint(context.Background(), root, nil); err == nil {
		t.Fatal("directory was accepted as a payload")
	}
}

func TestFingerprintRejectsCanceledCacheRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "payload")
	writeFixture(t, path, "original", 0600)
	var cache discovery.PayloadFingerprintCache
	if _, err := cache.Fingerprint(context.Background(), path, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.Fingerprint(ctx, path, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled cached observation was accepted: %v", err)
	}
}
