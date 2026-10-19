//go:build linux

package sources

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

var (
	snapshotCommitPattern = regexp.MustCompile(`^[a-f0-9]{40}(?:[a-f0-9]{24})?$`)
	snapshotRefPattern    = regexp.MustCompile(`^refs/foreman/ci/(?:[a-f0-9]{40}(?:[a-f0-9]{24})?|snapshots/[a-f0-9-]{36})$`)
)

// SnapshotGit is the existing Git process port bound to one already accepted
// canonical worktree or private clone. The core never receives a request path.
// The adapter must retain the caller's root/binding identity checks, explicit
// environment, cache reservations and inherited ownership, and call
// RunGitProcess with its own bounded supervisor timeout. Port errors preserve
// failures from those boundaries; a nonzero Git result is sanitized here.
type SnapshotGit func(context.Context, []string, map[string]string) (GitProcessResult, error)

// AgentSnapshot owns a Git commit and optional bundle bytes. It is a private
// domain representation, not a generated request/result or transport DTO.
// The zero value is invalid. A nil bundle means the commit already exists;
// an empty, non-nil bundle still requires bundle verification.
type AgentSnapshot struct {
	commit string
	bundle []byte
}

// NewAgentSnapshot copies bounded bytes after validating the Git identity.
// maxBundleBytes must come from the caller's generated source policy; there is
// no default policy or wire validation in this package.
func NewAgentSnapshot(commit string, bundle []byte, maxBundleBytes int64) (AgentSnapshot, error) {
	snapshot := AgentSnapshot{commit: commit, bundle: bundle}
	if err := snapshot.validate(maxBundleBytes); err != nil {
		return AgentSnapshot{}, err
	}
	snapshot.bundle = bytes.Clone(bundle)
	return snapshot, nil
}

// Commit is the captured Git object identity.
func (snapshot AgentSnapshot) Commit() string { return snapshot.commit }

// Bundle returns an independent copy, preserving nil versus empty bytes.
func (snapshot AgentSnapshot) Bundle() []byte { return bytes.Clone(snapshot.bundle) }

func (snapshot AgentSnapshot) validate(maxBundleBytes int64) error {
	if !snapshotCommitPattern.MatchString(snapshot.commit) {
		return snapshotError("SOURCE_SNAPSHOT_INVALID", "The snapshot commit is invalid.")
	}
	if maxBundleBytes <= 0 {
		return snapshotError("SOURCE_SNAPSHOT_INVALID", "A positive snapshot bundle limit is required.")
	}
	if int64(len(snapshot.bundle)) > maxBundleBytes {
		return snapshotTooLarge()
	}
	return nil
}

// SnapshotAgentWorktree captures current tracked and untracked, non-ignored
// files using a temporary index. Files matching the base tree reuse baseCommit;
// otherwise the snapshot commit has the working HEAD as its parent. Neither
// HEAD nor the worktree's own index moves. The caller binds git to the accepted
// worktree and supplies the generated bundle byte limit before entering here.
func SnapshotAgentWorktree(ctx context.Context, git SnapshotGit, baseCommit string, maxBundleBytes int64) (snapshot AgentSnapshot, err error) {
	if !snapshotCommitPattern.MatchString(baseCommit) {
		return AgentSnapshot{}, snapshotError("SOURCE_SNAPSHOT_INVALID", "The base commit is invalid.")
	}
	if err := validateSnapshotPort(git, maxBundleBytes); err != nil {
		return AgentSnapshot{}, err
	}
	scratch, err := os.MkdirTemp("", "foreman-ci-snapshot-")
	if err != nil {
		return AgentSnapshot{}, err
	}
	defer func() {
		// As in the original orchestration, scratch removal failure takes
		// precedence over an earlier Git or bundle failure.
		if cleanupErr := os.RemoveAll(scratch); cleanupErr != nil {
			snapshot, err = AgentSnapshot{}, cleanupErr
		}
	}()
	ancestor, err := git(ctx, []string{"merge-base", "--is-ancestor", baseCommit, "HEAD"}, nil)
	if err != nil {
		return AgentSnapshot{}, err
	}
	if ancestor.Code != 0 {
		return AgentSnapshot{}, snapshotError("SOURCE_SNAPSHOT_INVALID", "This folder is not an Agent worktree of the approved base.")
	}
	tree, err := snapshotTree(ctx, git, scratch)
	if err != nil {
		return AgentSnapshot{}, err
	}
	baseTree, err := runSnapshotGit(ctx, git, []string{"rev-parse", baseCommit + "^{tree}"}, nil)
	if err != nil {
		return AgentSnapshot{}, err
	}
	if tree == baseTree {
		return AgentSnapshot{commit: baseCommit}, nil
	}
	author := map[string]string{
		"GIT_AUTHOR_NAME":     "Foreman Code",
		"GIT_AUTHOR_EMAIL":    "ci@foreman-code.invalid",
		"GIT_COMMITTER_NAME":  "Foreman Code",
		"GIT_COMMITTER_EMAIL": "ci@foreman-code.invalid",
	}
	commit, err := runSnapshotGit(ctx, git, []string{"commit-tree", tree, "-p", "HEAD", "-m", "Foreman Code CI snapshot"}, author)
	if err != nil {
		return AgentSnapshot{}, err
	}
	if !snapshotCommitPattern.MatchString(commit) {
		return AgentSnapshot{}, snapshotGitFailure("commit-tree")
	}
	file := filepath.Join(scratch, "snapshot.bundle")
	if err := writeSnapshotBundle(ctx, git, file, baseCommit, commit); err != nil {
		return AgentSnapshot{}, err
	}
	bundle, err := readSnapshotBundle(file, maxBundleBytes)
	if err != nil {
		return AgentSnapshot{}, err
	}
	return AgentSnapshot{commit: commit, bundle: bundle}, nil
}

func snapshotTree(ctx context.Context, git SnapshotGit, scratch string) (string, error) {
	index := map[string]string{"GIT_INDEX_FILE": filepath.Join(scratch, "index")}
	if _, err := runSnapshotGit(ctx, git, []string{"read-tree", "HEAD"}, index); err != nil {
		return "", err
	}
	if _, err := runSnapshotGit(ctx, git, []string{"add", "-A"}, index); err != nil {
		return "", err
	}
	return runSnapshotGit(ctx, git, []string{"write-tree"}, index)
}

func writeSnapshotBundle(ctx context.Context, git SnapshotGit, file, baseCommit, commit string) (err error) {
	ref, err := newSnapshotRef()
	if err != nil {
		return err
	}
	defer func() {
		// The ref belongs to this operation, including when Git creates it
		// just before reporting cancellation. Cleanup keeps the same bound
		// port and runner-owned deadline, but outlives caller cancellation.
		// A rejected port call supersedes an earlier failure; a nonzero Git
		// cleanup result is ignored, matching the original precedence.
		_, cleanupErr := git(context.WithoutCancel(ctx), []string{"update-ref", "-d", ref}, nil)
		if cleanupErr != nil {
			err = cleanupErr
		}
	}()
	if _, err := runSnapshotGit(ctx, git, []string{"update-ref", ref, commit}, nil); err != nil {
		return err
	}
	_, err = runSnapshotGit(ctx, git, []string{"bundle", "create", file, ref, "^" + baseCommit}, nil)
	return err
}

func newSnapshotRef() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("refs/foreman/ci/snapshots/%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func readSnapshotBundle(path string, maxBundleBytes int64) (bundle []byte, err error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := file.Close(); err == nil && closeErr != nil {
			bundle, err = nil, closeErr
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, snapshotGitFailure("bundle")
	}
	if info.Size() > maxBundleBytes {
		return nil, snapshotTooLarge()
	}
	// The completed-file size check avoids reading an oversized bundle. The
	// reader also stays bounded if a file changes after that observation.
	bundle, err = io.ReadAll(io.LimitReader(file, maxBundleBytes))
	if err != nil {
		return nil, err
	}
	var extra [1]byte
	count, err := file.Read(extra[:])
	if count != 0 {
		return nil, snapshotTooLarge()
	}
	if err != nil && err != io.EOF {
		return nil, err
	}
	return bundle, nil
}

// ImportAgentSnapshot verifies an existing commit or a bounded Git bundle in
// the caller's already accepted private clone. Git verifies the fetched object
// graph; the advertised and imported ref must both identify snapshot.Commit().
// The deterministic imported ref is retained for later approval/checkout.
func ImportAgentSnapshot(ctx context.Context, git SnapshotGit, snapshot AgentSnapshot, maxBundleBytes int64) (err error) {
	if err := snapshot.validate(maxBundleBytes); err != nil {
		return err
	}
	if err := validateSnapshotPort(git, maxBundleBytes); err != nil {
		return err
	}
	if snapshot.bundle == nil {
		_, err := runSnapshotGit(ctx, git, []string{"cat-file", "-e", snapshot.commit + "^{commit}"}, nil)
		return err
	}
	scratch, err := os.MkdirTemp("", "foreman-ci-import-")
	if err != nil {
		return err
	}
	defer func() {
		if cleanupErr := os.RemoveAll(scratch); cleanupErr != nil {
			err = cleanupErr
		}
	}()
	file := filepath.Join(scratch, "snapshot.bundle")
	if err := os.WriteFile(file, snapshot.bundle, 0o600); err != nil {
		return err
	}
	heads, err := git(ctx, []string{"bundle", "list-heads", file}, nil)
	if err != nil {
		return err
	}
	fields := strings.Fields(heads.Stdout)
	if heads.Code != 0 || len(fields) < 2 || fields[0] != snapshot.commit || !snapshotRefPattern.MatchString(fields[1]) {
		return snapshotUnexpectedCommit()
	}
	ref := "refs/foreman/ci/" + snapshot.commit
	fetched, err := git(ctx, []string{"fetch", "--no-tags", file, fields[1] + ":" + ref}, nil)
	if err != nil {
		return err
	}
	if fetched.Code != 0 {
		return snapshotError("SOURCE_SNAPSHOT_FAILED", "The Agent snapshot could not be added to the clone.")
	}
	head, err := git(ctx, []string{"rev-parse", "--verify", ref + "^{commit}"}, nil)
	if err != nil {
		return err
	}
	if head.Code != 0 || strings.TrimSpace(head.Stdout) != snapshot.commit {
		return snapshotUnexpectedCommit()
	}
	return nil
}

func validateSnapshotPort(git SnapshotGit, maxBundleBytes int64) error {
	if git == nil {
		return snapshotError("SOURCE_SNAPSHOT_INVALID", "An accepted repository Git port is required.")
	}
	if maxBundleBytes <= 0 {
		return snapshotError("SOURCE_SNAPSHOT_INVALID", "A positive snapshot bundle limit is required.")
	}
	return nil
}

func runSnapshotGit(ctx context.Context, git SnapshotGit, args []string, env map[string]string) (string, error) {
	result, err := git(ctx, args, env)
	if err != nil {
		return "", err
	}
	if result.Code != 0 {
		return "", snapshotGitFailure(args[0])
	}
	return strings.TrimSpace(result.Stdout), nil
}

func snapshotError(code, message string) error {
	return domainerror.New(code, message, 400, nil)
}

func snapshotGitFailure(operation string) error {
	return snapshotError("SOURCE_SNAPSHOT_FAILED", "git "+operation+" failed. Check repository access and local Git configuration, then retry.")
}

func snapshotUnexpectedCommit() error {
	return snapshotError("SOURCE_SNAPSHOT_FAILED", "The Agent snapshot does not contain the expected commit.")
}

func snapshotTooLarge() error {
	return snapshotError("SOURCE_SNAPSHOT_TOO_LARGE", "These changes are too large to send for CI; push the branch instead.")
}
