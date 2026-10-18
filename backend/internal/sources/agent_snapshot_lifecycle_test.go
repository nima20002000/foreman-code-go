//go:build linux

package sources_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/sources"
)

func TestAgentSnapshotCancellationCleansOwnedState(t *testing.T) {
	for _, stage := range []string{"before start", "ref creation", "bundle creation"} {
		t.Run(stage, func(t *testing.T) {
			fixture := newSnapshotFixture(t)
			repository, base := fixture.repository("repository", "sha1")
			fixture.write(repository, "tracked.txt", "changed\n")
			before := fixture.state(repository)
			index := fixture.indexBytes(repository)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if stage == "before start" {
				cancel()
			}
			system := fixture.bound(repository)
			git := func(callCtx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
				if callCtx.Err() != nil {
					return sources.GitProcessResult{Code: 1}, nil
				}
				result, err := system(callCtx, args, env)
				creatingRef := args[0] == "update-ref" && args[1] != "-d"
				creatingBundle := args[0] == "bundle" && args[1] == "create"
				if err == nil && result.Code == 0 && ((stage == "ref creation" && creatingRef) || (stage == "bundle creation" && creatingBundle)) {
					// Git has persisted its result, but the process port observes
					// cancellation before returning, as the supervisor can do.
					cancel()
					result.Code = 1
				}
				return result, err
			}
			snapshot, err := sources.SnapshotAgentWorktree(ctx, git, base, 256*1024)
			code := "SOURCE_SNAPSHOT_FAILED"
			if stage == "before start" {
				code = "SOURCE_SNAPSHOT_INVALID"
			}
			assertSnapshotCode(t, err, code)
			if snapshot.Commit() != "" || snapshot.Bundle() != nil {
				t.Fatal("canceled capture returned a snapshot")
			}
			if !bytes.Equal(fixture.indexBytes(repository), index) {
				t.Fatal("canceled capture changed the worktree index bytes")
			}
			fixture.assertState(repository, before)
			if refs := fixture.git(repository, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
				t.Fatalf("canceled capture left owned refs: %s", refs)
			}
			fixture.assertScratchClean()
		})
	}
}

func TestAgentSnapshotCancellationCleansImportScratch(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	receiver := fixture.clone(repository, "receiver")
	fixture.write(repository, "tracked.txt", "changed\n")
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 256*1024)
	if err != nil {
		t.Fatal(err)
	}
	before := fixture.state(receiver)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	system := fixture.bound(receiver)
	git := func(callCtx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
		result, err := system(callCtx, args, env)
		if args[0] == "bundle" && args[1] == "list-heads" && err == nil && result.Code == 0 {
			cancel()
			result.Code = 1
		}
		return result, err
	}
	err = sources.ImportAgentSnapshot(ctx, git, snapshot, 256*1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_FAILED")
	fixture.assertState(receiver, before)
	if refs := fixture.git(receiver, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
		t.Fatalf("canceled bundle verification published refs: %s", refs)
	}
	fixture.assertScratchClean()
}

func TestAgentSnapshotPreservesPortAndCleanupErrors(t *testing.T) {
	for _, stage := range []string{"ancestry rejection", "bundle rejection", "cleanup status", "cleanup status after success", "cleanup rejection"} {
		t.Run(stage, func(t *testing.T) {
			fixture := newSnapshotFixture(t)
			repository, base := fixture.repository("repository", "sha1")
			fixture.write(repository, "tracked.txt", "changed\n")
			before := fixture.state(repository)
			primary := errors.New("source boundary rejected")
			cleanup := errors.New("cleanup boundary rejected")
			system := fixture.bound(repository)
			git := func(ctx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
				if (stage == "ancestry rejection" && args[0] == "merge-base") || (args[0] == "bundle" && stage != "cleanup status after success") {
					return sources.GitProcessResult{}, primary
				}
				result, err := system(ctx, args, env)
				if args[0] == "update-ref" && args[1] == "-d" && err == nil && result.Code == 0 {
					if stage == "cleanup rejection" {
						return result, cleanup
					}
					if stage == "cleanup status" || stage == "cleanup status after success" {
						result.Code = 1
					}
				}
				return result, err
			}
			snapshot, err := sources.SnapshotAgentWorktree(context.Background(), git, base, 256*1024)
			want := primary
			if stage == "cleanup rejection" {
				want = cleanup
			}
			if stage == "cleanup status after success" {
				want = nil
				if snapshot.Commit() == "" || snapshot.Commit() == base || len(snapshot.Bundle()) == 0 {
					t.Fatal("nonzero cleanup status discarded a successful snapshot")
				}
			}
			if err != want {
				t.Fatalf("boundary failure identity was lost: got %v, want %v", err, want)
			}
			fixture.assertState(repository, before)
			if refs := fixture.git(repository, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
				t.Fatalf("capture retained temporary refs after boundary rejection: %s", refs)
			}
			fixture.assertScratchClean()
		})
	}
}

func TestAgentSnapshotPreservesImportBoundaryErrors(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	receiver := fixture.clone(repository, "receiver")
	fixture.write(repository, "tracked.txt", "changed\n")
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 256*1024)
	if err != nil {
		t.Fatal(err)
	}
	boundary := errors.New("cache reservation rejected")
	system := fixture.bound(receiver)
	git := func(ctx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
		if args[0] == "fetch" {
			return sources.GitProcessResult{}, boundary
		}
		return system(ctx, args, env)
	}
	err = sources.ImportAgentSnapshot(context.Background(), git, snapshot, 256*1024)
	if err != boundary {
		t.Fatalf("import lost the existing boundary error: %v", err)
	}
	fixture.assertScratchClean()
}

func TestAgentSnapshotSanitizesGitFailures(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	fixture.write(repository, "tracked.txt", "changed\n")
	system := fixture.bound(repository)
	git := func(ctx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
		if args[0] == "bundle" {
			return sources.GitProcessResult{Code: 1, Stderr: "private-credential-value"}, nil
		}
		return system(ctx, args, env)
	}
	_, err := sources.SnapshotAgentWorktree(context.Background(), git, base, 256*1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_FAILED")
	if strings.Contains(err.Error(), "private-credential-value") {
		t.Fatal("Git diagnostics escaped through the public failure")
	}
	fixture.assertScratchClean()
}

func TestAgentSnapshotConcurrentCapturesRetainIndependentRefs(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	receiver := fixture.clone(repository, "receiver")
	fixture.write(repository, "tracked.txt", "concurrent change\n")
	before := fixture.state(repository)
	index := fixture.indexBytes(repository)
	system := fixture.bound(repository)
	secondBundling := make(chan struct{})
	firstDeleted := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	port := func(first bool) sources.SnapshotGit {
		return func(callCtx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
			if args[0] == "bundle" && args[1] == "create" {
				waiting := firstDeleted
				if first {
					waiting = secondBundling
				} else {
					close(secondBundling)
				}
				select {
				case <-waiting:
				case <-callCtx.Done():
					return sources.GitProcessResult{Code: 1}, nil
				}
			}
			result, err := system(callCtx, args, env)
			if first && args[0] == "update-ref" && args[1] == "-d" {
				close(firstDeleted)
			}
			return result, err
		}
	}
	type outcome struct {
		snapshot sources.AgentSnapshot
		err      error
	}
	results := make(chan outcome, 2)
	for _, first := range []bool{true, false} {
		go func(first bool) {
			snapshot, err := sources.SnapshotAgentWorktree(ctx, port(first), base, 256*1024)
			results <- outcome{snapshot: snapshot, err: err}
		}(first)
	}
	left, right := <-results, <-results
	if left.err != nil || right.err != nil {
		t.Fatalf("concurrent capture failed: %v; %v", left.err, right.err)
	}
	if left.snapshot.Commit() != right.snapshot.Commit() {
		t.Fatal("identical snapshot files, parent, author and timestamp changed commit identity")
	}
	if !bytes.Equal(fixture.indexBytes(repository), index) {
		t.Fatal("concurrent capture changed worktree index bytes")
	}
	for _, snapshot := range []sources.AgentSnapshot{left.snapshot, right.snapshot} {
		if err := sources.ImportAgentSnapshot(context.Background(), fixture.bound(receiver), snapshot, 256*1024); err != nil {
			t.Fatal(err)
		}
		if content := fixture.git(receiver, "show", snapshot.Commit()+":tracked.txt"); content != "concurrent change" {
			t.Fatalf("concurrent bundle did not retain current bytes: %q", content)
		}
	}
	fixture.assertState(repository, before)
	if refs := fixture.git(repository, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
		t.Fatalf("concurrent capture retained temporary refs: %s", refs)
	}
	fixture.assertScratchClean()
}
