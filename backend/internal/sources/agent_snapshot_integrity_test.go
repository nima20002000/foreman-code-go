//go:build linux

package sources_test

import (
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/sources"
)

func TestAgentSnapshotRejectsOversizedCapture(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	payload := make([]byte, 32*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "new.bin"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	before := fixture.state(repository)
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_TOO_LARGE")
	if snapshot.Commit() != "" || snapshot.Bundle() != nil {
		t.Fatal("oversized capture exposed a snapshot result")
	}
	fixture.assertState(repository, before)
	if refs := fixture.git(repository, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
		t.Fatalf("oversized capture retained temporary refs: %s", refs)
	}
	fixture.assertScratchClean()
}

func TestAgentSnapshotImportsExistingCommitOnlyForNilBundle(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	before := fixture.state(repository)
	for _, test := range []struct {
		name   string
		commit string
		bundle []byte
		fails  bool
	}{
		{name: "existing", commit: base},
		{name: "missing", commit: strings.Repeat("f", 40), fails: true},
		{name: "empty bytes", commit: base, bundle: []byte{}, fails: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, err := sources.NewAgentSnapshot(test.commit, test.bundle, 1)
			if err != nil {
				t.Fatal(err)
			}
			err = sources.ImportAgentSnapshot(context.Background(), fixture.bound(repository), snapshot, 1)
			if test.fails {
				assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_FAILED")
			} else if err != nil {
				t.Fatal(err)
			}
			fixture.assertState(repository, before)
			fixture.assertScratchClean()
		})
	}
}

func TestAgentSnapshotRejectsImportBeyondCallerLimit(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	receiver := fixture.clone(repository, "receiver")
	fixture.write(repository, "tracked.txt", "changed\n")
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 256*1024)
	if err != nil {
		t.Fatal(err)
	}
	before := fixture.state(receiver)
	err = sources.ImportAgentSnapshot(context.Background(), fixture.bound(receiver), snapshot, int64(len(snapshot.Bundle())-1))
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_TOO_LARGE")
	err = sources.ImportAgentSnapshot(context.Background(), fixture.bound(receiver), snapshot, 0)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	err = sources.ImportAgentSnapshot(context.Background(), nil, snapshot, 256*1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	err = sources.ImportAgentSnapshot(context.Background(), fixture.bound(receiver), sources.AgentSnapshot{}, 256*1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	fixture.assertState(receiver, before)
	if refs := fixture.git(receiver, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
		t.Fatalf("rejected import published refs: %s", refs)
	}
	fixture.assertScratchClean()
}

func TestAgentSnapshotVerifiesBundleIdentityAndIntegrity(t *testing.T) {
	for _, variant := range []string{"wrong commit", "wrong ref", "corrupt objects"} {
		t.Run(variant, func(t *testing.T) {
			fixture := newSnapshotFixture(t)
			repository, base := fixture.repository("repository", "sha1")
			receiver := fixture.clone(repository, "receiver")
			fixture.write(repository, "tracked.txt", "changed content\n")
			snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 256*1024)
			if err != nil {
				t.Fatal(err)
			}
			commit, bundle := snapshot.Commit(), snapshot.Bundle()
			switch variant {
			case "wrong commit":
				commit = base
			case "wrong ref":
				fixture.git(repository, "update-ref", "refs/heads/other", commit)
				file := filepath.Join(fixture.root, "other.bundle")
				fixture.git(repository, "bundle", "create", file, "refs/heads/other", "^"+base)
				bundle, err = os.ReadFile(file)
				if err != nil {
					t.Fatal(err)
				}
			case "corrupt objects":
				if len(bundle) == 0 {
					t.Fatal("fixture bundle is empty")
				}
				bundle[len(bundle)-1] ^= 0xff
			}
			input, err := sources.NewAgentSnapshot(commit, bundle, 256*1024)
			if err != nil {
				t.Fatal(err)
			}
			before := fixture.state(receiver)
			err = sources.ImportAgentSnapshot(context.Background(), fixture.bound(receiver), input, 256*1024)
			assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_FAILED")
			fixture.assertState(receiver, before)
			if refs := fixture.git(receiver, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
				t.Fatalf("invalid bundle published refs: %s", refs)
			}
			fixture.assertScratchClean()
		})
	}
}

func TestAgentSnapshotRejectsImportedRefMismatch(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	receiver := fixture.clone(repository, "receiver")
	fixture.write(repository, "tracked.txt", "changed content\n")
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 256*1024)
	if err != nil {
		t.Fatal(err)
	}
	before := fixture.state(receiver)
	system := fixture.bound(receiver)
	git := func(ctx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
		result, err := system(ctx, args, env)
		if args[0] == "fetch" && err == nil && result.Code == 0 {
			// Model a destination ref changed after fetch. Verification must
			// observe persisted Git identity rather than trusting fetch success.
			changed, changeErr := system(ctx, []string{"update-ref", "refs/foreman/ci/" + snapshot.Commit(), base}, nil)
			if changeErr != nil || changed.Code != 0 {
				t.Fatalf("could not prepare the isolated changed-ref state: code=%d err=%v", changed.Code, changeErr)
			}
		}
		return result, err
	}
	err = sources.ImportAgentSnapshot(context.Background(), git, snapshot, 256*1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_FAILED")
	fixture.assertState(receiver, before)
	fixture.assertScratchClean()
}
