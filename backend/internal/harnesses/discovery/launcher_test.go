//go:build linux || darwin

package discovery_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/discovery"
)

func writeFixture(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func resolvedFixture(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func targetEnvironment(directory string) discovery.TargetEnvironment {
	return discovery.TargetEnvironment{
		Generation: "1", Provenance: "worker", Cwd: directory,
		Path: ":relative:" + directory,
	}
}

func bytesDigest(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func TestDiscoveryUsesCapturedTargetEnvironmentWithoutExecuting(t *testing.T) {
	for _, provenance := range []string{"terminal", "gui", "systemd", "ssh", "worker"} {
		t.Run(provenance, func(t *testing.T) {
			root := t.TempDir()
			launcher := filepath.Join(root, "tool with spaces")
			marker := filepath.Join(root, "must-not-execute")
			writeFixture(t, launcher, "#!/bin/sh\nprintf launched > '"+marker+"'\n", 0700)
			environment := targetEnvironment(root)
			environment.Provenance = provenance
			evidence, err := discovery.DiscoverLauncher(context.Background(), "tool with spaces", environment, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if evidence.Status != "installed" || evidence.ResolvedLauncher == nil || *evidence.ResolvedLauncher != resolvedFixture(t, launcher) {
				t.Fatalf("unexpected launcher evidence: %+v", evidence)
			}
			if evidence.Environment != environment || len(evidence.Diagnostics) != 2 {
				t.Fatalf("captured target environment was not retained: %+v", evidence)
			}
			if _, err := time.Parse("2006-01-02T15:04:05.000Z", evidence.CheckedAt); err != nil {
				t.Fatalf("invalid observation time %q: %v", evidence.CheckedAt, err)
			}
			if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("passive discovery executed the launcher: %v", err)
			}
		})
	}
}

func TestDiscoveryDoesNotSearchRelativePATHEntries(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "codex"), "native", 0700)
	environment := targetEnvironment(root)
	environment.Path = ":.:relative"
	evidence, err := discovery.DiscoverLauncher(context.Background(), "codex", environment, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "missing" || len(evidence.Diagnostics) != 3 || evidence.ResolvedLauncher != nil {
		t.Fatalf("relative PATH resolved a working-directory launcher: %+v", evidence)
	}
}

func TestDiscoveryDoesNotReplaceExplicitMissingLauncher(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "codex"), "native", 0700)
	requested := filepath.Join(root, "absent", "codex")
	evidence, err := discovery.DiscoverLauncher(context.Background(), requested, targetEnvironment(root), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "missing" || evidence.ResolvedLauncher != nil {
		t.Fatalf("explicit missing path fell back to PATH: %+v", evidence)
	}
}

func TestDiscoveryResolvesExplicitRelativeLauncherAgainstTargetCwd(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(root, "bin", "codex")
	writeFixture(t, launcher, "native", 0700)
	evidence, err := discovery.DiscoverLauncher(context.Background(), "bin/codex", targetEnvironment(root), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "installed" || evidence.ResolvedLauncher == nil || *evidence.ResolvedLauncher != resolvedFixture(t, launcher) {
		t.Fatalf("explicit relative path used another cwd: %+v", evidence)
	}
}

func TestDiscoveryDistinguishesUnavailableLauncherEvidence(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "noexec"), "payload", 0600)
	if err := os.Mkdir(filepath.Join(root, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "absent"), filepath.Join(root, "broken")); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(root, "script"), "#!/missing/interpreter\n", 0700)
	for _, fixture := range []struct{ name, status string }{
		{"missing", "missing"}, {"noexec", "not-executable"},
		{"directory", "not-executable"}, {"broken", "broken-symlink"},
		{"script", "missing-interpreter"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			evidence, err := discovery.DiscoverLauncher(context.Background(), fixture.name, targetEnvironment(root), nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if evidence.Status != fixture.status || evidence.Fingerprint != nil {
				t.Fatalf("expected %s evidence, got %+v", fixture.status, evidence)
			}
		})
	}
}

func TestDiscoveryResolvesEnvInterpreterOnlyFromTargetPATH(t *testing.T) {
	root := t.TempDir()
	interpreter := filepath.Join(root, "target-interpreter")
	writeFixture(t, interpreter, "native interpreter", 0700)
	launcher := filepath.Join(root, "launcher")
	writeFixture(t, launcher, "#!/usr/bin/env target-interpreter\n", 0700)
	evidence, err := discovery.DiscoverLauncher(context.Background(), launcher, targetEnvironment(root), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "installed" || evidence.Interpreter == nil || *evidence.Interpreter != resolvedFixture(t, interpreter) {
		t.Fatalf("target interpreter was not selected: %+v", evidence)
	}
	environment := targetEnvironment(root)
	environment.Path = filepath.Join(root, "absent")
	evidence, err = discovery.DiscoverLauncher(context.Background(), launcher, environment, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "missing-interpreter" {
		t.Fatalf("interpreter search escaped target PATH: %+v", evidence)
	}
}

func TestDiscoveryRejectsEnvShebangOptions(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "launcher")
	writeFixture(t, launcher, "#!/usr/bin/env -S sh -e\n", 0700)
	evidence, err := discovery.DiscoverLauncher(context.Background(), launcher, targetEnvironment(root), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "missing-interpreter" || evidence.Fingerprint != nil {
		t.Fatalf("unsupported interpreter arguments were treated as installed: %+v", evidence)
	}
}

func TestDiscoveryFingerprintsReadablePayloadsInSuppliedOrder(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "launcher")
	payload := filepath.Join(root, "sdk-payload")
	writeFixture(t, launcher, "native", 0700)
	writeFixture(t, payload, "native-one", 0600)
	first, err := discovery.DiscoverLauncher(context.Background(), launcher, targetEnvironment(root), []string{payload}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "installed" || len(first.PayloadFingerprints) != 2 {
		t.Fatalf("readable SDK payload incorrectly required executable access: %+v", first)
	}
	if first.PayloadFingerprints[0].Path != resolvedFixture(t, launcher) || first.PayloadFingerprints[1].Path != resolvedFixture(t, payload) || first.PayloadFingerprints[1].Fingerprint != bytesDigest("native-one") {
		t.Fatalf("native payload observation mismatch: %+v", first)
	}
	writeFixture(t, payload, "native-two", 0600)
	second, err := discovery.DiscoverLauncher(context.Background(), launcher, targetEnvironment(root), []string{payload}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint == nil || second.Fingerprint == nil || *first.Fingerprint == *second.Fingerprint {
		t.Fatalf("payload change retained the old launcher identity: first=%+v second=%+v", first, second)
	}
}

func TestDiscoveryUsesNativeJSONStringifyFingerprint(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"html-<>&", "separator-\u2028\u2029", `literal-\u2028\u2029`} {
		t.Run(name, func(t *testing.T) {
			launcher := filepath.Join(root, name)
			writeFixture(t, launcher, "native", 0700)
			evidence, err := discovery.DiscoverLauncher(context.Background(), launcher, targetEnvironment(root), nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			path := strings.ReplaceAll(resolvedFixture(t, launcher), `\`, `\\`)
			wire := fmt.Sprintf(`[{"path":"%s","fingerprint":"%s"}]`, path, bytesDigest("native"))
			if evidence.Fingerprint == nil || *evidence.Fingerprint != bytesDigest(wire) {
				t.Fatalf("native JSON fingerprint differs for %q: %+v", name, evidence)
			}
		})
	}
}

type cancelFingerprint struct {
	cancel context.CancelFunc
}

func (f cancelFingerprint) Fingerprint(ctx context.Context, _ string, _ os.FileInfo) (string, error) {
	f.cancel()
	return "", ctx.Err()
}

func TestDiscoveryPropagatesCancellationWithoutInstalledEvidence(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "launcher")
	writeFixture(t, launcher, "native", 0700)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	evidence, err := discovery.DiscoverLauncher(ctx, launcher, targetEnvironment(root), nil, cancelFingerprint{cancel: cancel})
	if !errors.Is(err, context.Canceled) || evidence.Status == "installed" || evidence.Fingerprint != nil {
		t.Fatalf("canceled observation was retained: evidence=%+v error=%v", evidence, err)
	}
}

func TestDiscoveryDoesNotClaimInstalledWhenExplicitPayloadIsMissing(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "launcher")
	writeFixture(t, launcher, "native", 0700)
	evidence, err := discovery.DiscoverLauncher(context.Background(), launcher, targetEnvironment(root), []string{filepath.Join(root, "absent")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Status != "unreadable" || evidence.Fingerprint != nil {
		t.Fatalf("missing payload was admitted as installed: %+v", evidence)
	}
}
