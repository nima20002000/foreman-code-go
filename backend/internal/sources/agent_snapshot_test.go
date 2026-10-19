//go:build linux

package sources_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/sources"
)

type snapshotFixture struct {
	t           *testing.T
	root        string
	scratch     string
	environment map[string]string
}

func newSnapshotFixture(t *testing.T) *snapshotFixture {
	t.Helper()
	root := t.TempDir()
	scratch := filepath.Join(root, "scratch")
	home := filepath.Join(root, "home")
	for _, directory := range []string{scratch, home} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("TMPDIR", scratch)
	return &snapshotFixture{
		t:       t,
		root:    root,
		scratch: scratch,
		environment: map[string]string{
			"PATH":                "/usr/bin:/bin",
			"HOME":                home,
			"TMPDIR":              scratch,
			"XDG_CONFIG_HOME":     home,
			"XDG_CACHE_HOME":      home,
			"GIT_CONFIG_GLOBAL":   "/dev/null",
			"GIT_CONFIG_SYSTEM":   "/dev/null",
			"GIT_AUTHOR_NAME":     "Fixture",
			"GIT_AUTHOR_EMAIL":    "fixture@example.invalid",
			"GIT_COMMITTER_NAME":  "Fixture",
			"GIT_COMMITTER_EMAIL": "fixture@example.invalid",
			"GIT_AUTHOR_DATE":     "2000-01-01T00:00:00Z",
			"GIT_COMMITTER_DATE":  "2000-01-01T00:00:00Z",
		},
	}
}

func (fixture *snapshotFixture) bound(directory string) sources.SnapshotGit {
	return func(ctx context.Context, args []string, env map[string]string) (sources.GitProcessResult, error) {
		deadline := 10 * time.Second
		return sources.RunGitProcess(ctx, args, sources.GitProcessOptions{
			Cwd: directory, Env: env, Timeout: &deadline,
		}, fixture.environment), nil
	}
}

func (fixture *snapshotFixture) git(directory string, args ...string) string {
	fixture.t.Helper()
	result, err := fixture.bound(directory)(context.Background(), args, nil)
	if err != nil || result.Code != 0 {
		fixture.t.Fatalf("isolated Git command failed: code=%d err=%v stderr=%q", result.Code, err, result.Stderr)
	}
	return strings.TrimSpace(result.Stdout)
}

func (fixture *snapshotFixture) write(directory, path, contents string) {
	fixture.t.Helper()
	file := filepath.Join(directory, path)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		fixture.t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(contents), 0o600); err != nil {
		fixture.t.Fatal(err)
	}
}

func (fixture *snapshotFixture) repository(name, format string) (string, string) {
	fixture.t.Helper()
	directory := filepath.Join(fixture.root, name)
	if err := os.Mkdir(directory, 0o700); err != nil {
		fixture.t.Fatal(err)
	}
	fixture.git(directory, "init", "-q", "-b", "main", "--template=", "--object-format="+format)
	fixture.write(directory, "tracked.txt", "base\n")
	fixture.write(directory, "removed.txt", "remove me\n")
	fixture.write(directory, ".gitignore", "ignored/\n")
	fixture.git(directory, "add", ".")
	fixture.git(directory, "commit", "-qm", "base")
	return directory, fixture.git(directory, "rev-parse", "HEAD")
}

func (fixture *snapshotFixture) clone(source, name string) string {
	fixture.t.Helper()
	directory := filepath.Join(fixture.root, name)
	fixture.git(fixture.root, "clone", "-q", "--template=", "--no-hardlinks", source, directory)
	return directory
}

type snapshotRepositoryState struct {
	head   string
	index  string
	status string
}

func (fixture *snapshotFixture) state(directory string) snapshotRepositoryState {
	fixture.t.Helper()
	return snapshotRepositoryState{
		head:   fixture.git(directory, "rev-parse", "HEAD"),
		index:  fixture.git(directory, "ls-files", "--stage", "-z"),
		status: fixture.git(directory, "status", "--porcelain=v1", "-z"),
	}
}

func (fixture *snapshotFixture) indexBytes(directory string) []byte {
	fixture.t.Helper()
	path := fixture.git(directory, "rev-parse", "--path-format=absolute", "--git-path", "index")
	data, err := os.ReadFile(path)
	if err != nil {
		fixture.t.Fatal(err)
	}
	return data
}

func (fixture *snapshotFixture) assertState(directory string, expected snapshotRepositoryState) {
	fixture.t.Helper()
	actual := fixture.state(directory)
	if actual != expected {
		fixture.t.Fatalf("snapshot changed worktree HEAD, index or status: before=%+v after=%+v", expected, actual)
	}
}

func (fixture *snapshotFixture) assertScratchClean() {
	fixture.t.Helper()
	entries, err := os.ReadDir(fixture.scratch)
	if err != nil {
		fixture.t.Fatal(err)
	}
	if len(entries) != 0 {
		fixture.t.Fatalf("snapshot left %d owned scratch entries", len(entries))
	}
}

func assertSnapshotCode(t *testing.T, err error, code string) {
	t.Helper()
	domain, ok := domainerror.As(err)
	if !ok || domain.Code != code || domain.Status != 400 {
		t.Fatalf("snapshot error=%v, want public code %s with status 400", err, code)
	}
}

func TestAgentSnapshotReusesUnchangedBase(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	fixture.write(repository, "ignored/output.txt", "runtime output\n")
	before := fixture.state(repository)
	// A clean tree does not need bundle capacity, regardless of source size.
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 1)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Commit() != base || snapshot.Bundle() != nil {
		t.Fatal("unchanged files did not reuse the base commit without bytes")
	}
	fixture.assertState(repository, before)
	fixture.assertScratchClean()
	if refs := fixture.git(repository, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
		t.Fatalf("unchanged capture retained snapshot refs: %s", refs)
	}
}

func TestAgentSnapshotReusesBaseAfterHeadAdvances(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	fixture.write(repository, "tracked.txt", "committed change\n")
	fixture.git(repository, "commit", "-qam", "advance branch")
	fixture.write(repository, "tracked.txt", "base\n")
	before := fixture.state(repository)
	if before.head == base {
		t.Fatal("fixture did not advance the branch")
	}
	snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, 1)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Commit() != base || snapshot.Bundle() != nil {
		t.Fatal("a working tree matching the base reused HEAD instead of the base")
	}
	fixture.assertState(repository, before)
	fixture.assertScratchClean()
}

func TestAgentSnapshotCapturesAndImportsCurrentFiles(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			fixture := newSnapshotFixture(t)
			repository, base := fixture.repository("repository", format)
			receiver := fixture.clone(repository, "receiver")
			fixture.write(repository, "tracked.txt", "committed change\n")
			fixture.git(repository, "commit", "-qam", "advance branch")
			fixture.write(repository, "tracked.txt", "staged change\n")
			fixture.git(repository, "add", "tracked.txt")
			fixture.write(repository, "tracked.txt", "current unstaged bytes\n")
			fixture.write(repository, "new.txt", "new content\n")
			fixture.write(repository, "ignored/output.txt", "ignored content\n")
			if err := os.Remove(filepath.Join(repository, "removed.txt")); err != nil {
				t.Fatal(err)
			}
			before := fixture.state(repository)
			receiverBefore := fixture.state(receiver)
			index := fixture.indexBytes(repository)
			limit := int64(256 * 1024)
			snapshot, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, limit)
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.Commit() == base || len(snapshot.Bundle()) == 0 {
				t.Fatal("changed files did not produce a commit and bundle")
			}
			if !bytes.Equal(fixture.indexBytes(repository), index) {
				t.Fatal("snapshot changed the worktree index bytes")
			}
			if parent := fixture.git(repository, "rev-parse", snapshot.Commit()+"^"); parent != before.head {
				t.Fatalf("snapshot parent=%s, want working HEAD %s", parent, before.head)
			}
			identity := fixture.git(repository, "show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%s", snapshot.Commit())
			wantIdentity := "Foreman Code <ci@foreman-code.invalid>\nForeman Code <ci@foreman-code.invalid>\nForeman Code CI snapshot"
			if identity != wantIdentity {
				t.Fatalf("snapshot commit metadata changed: %q", identity)
			}
			if err := sources.ImportAgentSnapshot(context.Background(), fixture.bound(receiver), snapshot, limit); err != nil {
				t.Fatal(err)
			}
			ref := "refs/foreman/ci/" + snapshot.Commit()
			if imported := fixture.git(receiver, "rev-parse", "--verify", ref+"^{commit}"); imported != snapshot.Commit() {
				t.Fatalf("imported Git identity=%s, want %s", imported, snapshot.Commit())
			}
			for file, want := range map[string]string{"tracked.txt": "current unstaged bytes", "new.txt": "new content"} {
				if actual := fixture.git(receiver, "show", snapshot.Commit()+":"+file); actual != want {
					t.Fatalf("imported %s=%q, want %q", file, actual, want)
				}
			}
			if names := fixture.git(receiver, "ls-tree", "-r", "--name-only", snapshot.Commit()); names != ".gitignore\nnew.txt\ntracked.txt" {
				t.Fatalf("snapshot ignored/deleted entries are wrong: %q", names)
			}
			fixture.assertState(repository, before)
			fixture.assertState(receiver, receiverBefore)
			if refs := fixture.git(repository, "for-each-ref", "--format=%(refname)", "refs/foreman/ci/"); refs != "" {
				t.Fatalf("capture retained temporary refs: %s", refs)
			}
			fixture.assertScratchClean()
		})
	}
}

func TestAgentSnapshotRejectsInvalidInputs(t *testing.T) {
	fixture := newSnapshotFixture(t)
	repository, base := fixture.repository("repository", "sha1")
	before := fixture.state(repository)
	for _, commit := range []string{"", "HEAD", "--all", "A" + strings.Repeat("a", 39), strings.Repeat("a", 41)} {
		_, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), commit, 1024)
		assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	}
	_, err := sources.SnapshotAgentWorktree(context.Background(), nil, base, 1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	for _, limit := range []int64{0, -1} {
		_, err := sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), base, limit)
		assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	}
	_, err = sources.SnapshotAgentWorktree(context.Background(), fixture.bound(repository), strings.Repeat("f", 40), 1024)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_INVALID")
	fixture.assertState(repository, before)
	fixture.assertScratchClean()
}

func TestAgentSnapshotOwnsBytesAndPreservesEmptyBundle(t *testing.T) {
	commit := strings.Repeat("a", 40)
	input := []byte{1, 2, 3}
	snapshot, err := sources.NewAgentSnapshot(commit, input, int64(len(input)))
	if err != nil {
		t.Fatal(err)
	}
	input[0] = 9
	copy := snapshot.Bundle()
	copy[1] = 9
	if !bytes.Equal(snapshot.Bundle(), []byte{1, 2, 3}) || snapshot.Commit() != commit {
		t.Fatal("snapshot bytes or identity changed through an external alias")
	}
	for _, input := range [][]byte{nil, {}} {
		snapshot, err := sources.NewAgentSnapshot(commit, input, 1)
		if err != nil {
			t.Fatal(err)
		}
		if (snapshot.Bundle() == nil) != (input == nil) {
			t.Fatal("snapshot changed nil versus empty bundle semantics")
		}
	}
	_, err = sources.NewAgentSnapshot(commit, []byte{1, 2}, 1)
	assertSnapshotCode(t, err, "SOURCE_SNAPSHOT_TOO_LARGE")
}
