//go:build linux

package roots_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/roots"
)

func openProject(t *testing.T, parent *roots.Directory, path string) *roots.Directory {
	t.Helper()
	directory, err := parent.OpenProject(path)
	if err != nil {
		t.Fatal(err)
	}
	return retainDirectory(t, directory)
}

func requireProjectMode(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != mode {
		t.Fatalf("directory permissions changed: got %o; want %o", info.Mode().Perm(), mode)
	}
}

func projectDirectoryHandles(t *testing.T, paths ...string) int {
	t.Helper()
	identities := make([]os.FileInfo, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		identities = append(identities, info)
	}
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		info, err := os.Stat(filepath.Join("/proc/self/fd", entry.Name()))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		for _, expected := range identities {
			if os.SameFile(info, expected) {
				count++
				break
			}
		}
	}
	return count
}

func TestOpenProjectPreservesProtectedDirectories(t *testing.T) {
	base := filepath.Join(t.TempDir(), "base")
	project := filepath.Join(base, "project")
	leaf := filepath.Join(project, "nested")
	for _, path := range []string{base, project, leaf} {
		makeDirectory(t, path, 0o755)
	}
	marker := filepath.Join(leaf, "notes.txt")
	contents := []byte("the existing project stays unchanged\n")
	if err := os.WriteFile(marker, contents, 0o640); err != nil {
		t.Fatal(err)
	}
	root := openRoot(t, base, false)
	directory := openProject(t, root, "project/nested")
	info, err := directory.Stat()
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(leaf)
	if err != nil || !os.SameFile(info, expected) {
		t.Fatalf("opened directory differs from the existing project: %v", err)
	}
	for _, path := range []string{base, project, leaf} {
		requireProjectMode(t, path, 0o755)
		entries, err := os.ReadDir(path)
		if err != nil || len(entries) != 1 {
			t.Fatalf("project entries changed: %v, %v", entries, err)
		}
	}
	actual, err := os.ReadFile(marker)
	if err != nil || !bytes.Equal(actual, contents) {
		t.Fatalf("project contents changed: %q, %v", actual, err)
	}
}

func TestOpenProjectFollowsPrivatePrefixPermissions(t *testing.T) {
	cases := []struct {
		name     string
		baseMode os.FileMode
		modes    []os.FileMode
		accepted bool
	}{
		{"protected-readable", 0o755, []os.FileMode{0o755, 0o555}, true},
		{"group-readable-stays-protected", 0o755, []os.FileMode{0o750, 0o770}, false},
		{"group-writable-child", 0o755, []os.FileMode{0o770}, false},
		{"other-writable-child", 0o755, []os.FileMode{0o707}, false},
		{"protected-grandchild", 0o755, []os.FileMode{0o755, 0o777}, false},
		{"private-base", 0o700, []os.FileMode{0o777, 0o777}, true},
		{"readonly-private-base", 0o500, []os.FileMode{0o777}, true},
		{"private-prefix", 0o755, []os.FileMode{0o700, 0o777, 0o777}, true},
		{"readonly-private-prefix", 0o755, []os.FileMode{0o500, 0o777, 0o755}, true},
		{"readonly-protected-base", 0o555, []os.FileMode{0o755}, true},
		{"private-prefix-stays-private", 0o755, []os.FileMode{0o700, 0o755, 0o777}, true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			base := filepath.Join(t.TempDir(), "base")
			makeDirectory(t, base, 0o700)
			paths := []string{base}
			parts := make([]string, 0, len(item.modes))
			for range item.modes {
				parts = append(parts, "child")
				path := filepath.Join(paths[len(paths)-1], "child")
				makeDirectory(t, path, 0o700)
				paths = append(paths, path)
			}
			t.Cleanup(func() {
				for _, path := range paths {
					if err := os.Chmod(path, 0o700); err != nil {
						t.Error(err)
					}
				}
			})
			modes := append([]os.FileMode{item.baseMode}, item.modes...)
			for index := len(paths) - 1; index >= 0; index-- {
				if err := os.Chmod(paths[index], modes[index]); err != nil {
					t.Fatal(err)
				}
			}
			root := openRoot(t, base, false)
			directory, err := root.OpenProject(strings.Join(parts, "/"))
			if directory != nil {
				retainDirectory(t, directory)
			}
			if item.accepted {
				if err != nil || directory == nil {
					t.Fatalf("existing project was rejected: %v", err)
				}
				info, err := directory.Stat()
				if err != nil {
					t.Fatal(err)
				}
				expected, err := os.Stat(paths[len(paths)-1])
				if err != nil || !os.SameFile(info, expected) {
					t.Fatalf("opened the wrong project: %v", err)
				}
			} else {
				if directory != nil {
					t.Fatal("rejected project returned a live directory")
				}
				requireCode(t, err, "ROOT_FILESYSTEM_UNSUPPORTED", 400)
			}
			for index, path := range paths {
				requireProjectMode(t, path, modes[index])
			}
		})
	}
}

func TestOpenProjectRejectsTraversalAndAmbiguousNames(t *testing.T) {
	base := t.TempDir()
	root := openRoot(t, base, true)
	for _, path := range []string{
		"/absolute", ".", "..", "../outside", "a/../b", "a/./b", "a//b", "a/",
		"a\\b", "C:folder", "a:b", "a.", "a ", "a./b", "a /b",
		"a\x00b", "a\nb", "a\tb", "a\x7fb", "cafe\u0301", string([]byte{0xff}),
		strings.Repeat("a", 1025), strings.Repeat("😀", 513), strings.Repeat("a/", 32) + "a",
	} {
		directory, err := root.OpenProject(path)
		if directory != nil {
			retainDirectory(t, directory)
			t.Fatalf("accepted an ambiguous project path %q", path)
		}
		requireCode(t, err, "ROOT_RELATIVE_PATH_INVALID", 400)
	}
	entries, err := os.ReadDir(base)
	if err != nil || len(entries) != 0 {
		t.Fatalf("invalid project paths changed the base: %v, %v", entries, err)
	}
}

func TestOpenProjectPreservesNativeNames(t *testing.T) {
	base := t.TempDir()
	root := openRoot(t, base, true)
	for _, name := range []string{"folder with spaces", ".hidden", "café", "資料😀"} {
		path := filepath.Join(base, name)
		makeDirectory(t, path, 0o755)
		directory := openProject(t, root, name)
		info, err := directory.Stat()
		if err != nil {
			t.Fatal(err)
		}
		expected, err := os.Stat(path)
		if err != nil || !os.SameFile(info, expected) {
			t.Fatalf("native project name was changed: %v", err)
		}
	}
}

func TestOpenProjectClassifiesMissingDirectoriesAndSymlinks(t *testing.T) {
	base := filepath.Join(t.TempDir(), "base")
	makeDirectory(t, base, 0o755)
	makeDirectory(t, filepath.Join(base, "project"), 0o755)
	makeDirectory(t, filepath.Join(base, "target"), 0o755)
	contents := []byte("ordinary file remains untouched")
	if err := os.WriteFile(filepath.Join(base, "file"), contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "target"), filepath.Join(base, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "absent"), filepath.Join(base, "dangling")); err != nil {
		t.Fatal(err)
	}
	root := openRoot(t, base, false)
	cases := []struct {
		name  string
		path  string
		cause error
	}{
		{"missing-leaf", "project/missing", syscall.ENOENT},
		{"missing-intermediate", "missing/child", syscall.ENOENT},
		{"ordinary-file-leaf", "file", syscall.ENOTDIR},
		{"ordinary-file-intermediate", "file/child", syscall.ENOTDIR},
		{"symlink-leaf", "link", syscall.ENOTDIR},
		{"symlink-intermediate", "link/child", syscall.ENOTDIR},
		{"dangling-symlink", "dangling", syscall.ENOTDIR},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			directory, err := root.OpenProject(item.path)
			if directory != nil {
				retainDirectory(t, directory)
				t.Fatal("missing or non-directory project returned a handle")
			}
			requireCode(t, err, "ROOT_DIRECTORY_MISSING", 400)
			if !errors.Is(err, item.cause) {
				t.Fatalf("missing-directory failure lost its native cause: %v", err)
			}
		})
	}
	actual, err := os.ReadFile(filepath.Join(base, "file"))
	if err != nil || !bytes.Equal(actual, contents) {
		t.Fatalf("ordinary file was changed: %q, %v", actual, err)
	}
	for _, name := range []string{"project", "target"} {
		entries, err := os.ReadDir(filepath.Join(base, name))
		if err != nil || len(entries) != 0 {
			t.Fatalf("project opener created a missing directory: %v, %v", entries, err)
		}
	}
}

func TestOpenProjectPreservesNativeOpenErrors(t *testing.T) {
	base := t.TempDir()
	root := openRoot(t, base, true)
	directory, err := root.OpenProject(strings.Repeat("a", 256))
	if directory != nil {
		retainDirectory(t, directory)
		t.Fatal("an overlong native filename returned a directory")
	}
	if !errors.Is(err, syscall.ENAMETOOLONG) {
		t.Fatalf("native filename failure changed: %v", err)
	}
	if _, ok := domainerror.As(err); ok {
		t.Fatalf("native filename failure became a domain failure: %v", err)
	}
}

func TestOpenProjectKeepsEmptyPathHandleIndependent(t *testing.T) {
	base := t.TempDir()
	root := openRoot(t, base, true)
	first := openProject(t, root, "")
	second := openProject(t, root, "")
	sameDirectory(t, root, first, true)
	sameDirectory(t, first, second, true)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := root.Stat(); err != nil {
		t.Fatalf("closing an empty-path result closed its base: %v", err)
	}
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.Stat(); err != nil {
		t.Fatalf("closing the base closed an independent result: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if count := projectDirectoryHandles(t, base); count != 0 {
		t.Fatalf("closed empty-path results left %d directory handles", count)
	}
}

func TestOpenProjectStaysPinnedAfterPathReplacement(t *testing.T) {
	fixture := t.TempDir()
	base := filepath.Join(fixture, "base")
	project := filepath.Join(base, "project")
	for _, path := range []string{base, project, filepath.Join(project, "nested")} {
		makeDirectory(t, path, 0o755)
	}
	root := openRoot(t, base, false)
	before := openProject(t, root, "project/nested")
	moved := filepath.Join(fixture, "retained")
	if err := os.Rename(base, moved); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{base, project, filepath.Join(project, "nested")} {
		makeDirectory(t, path, 0o755)
	}
	after := openProject(t, root, "project/nested")
	replacement := openProject(t, openRoot(t, base, false), "project/nested")
	sameDirectory(t, before, after, true)
	sameDirectory(t, before, replacement, false)
	info, err := after.Stat()
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(filepath.Join(moved, "project", "nested"))
	if err != nil || !os.SameFile(info, expected) {
		t.Fatalf("pinned traversal followed the replacement pathname: %v", err)
	}
}

func TestOpenProjectReturnsIndependentDescendants(t *testing.T) {
	base := t.TempDir()
	project := filepath.Join(base, "project")
	makeDirectory(t, project, 0o755)
	makeDirectory(t, filepath.Join(project, "nested"), 0o755)
	root := openRoot(t, base, true)
	parent := openProject(t, root, "project")
	first := openProject(t, root, "project/nested")
	second := openProject(t, parent, "nested")
	sameDirectory(t, first, second, true)
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if err := parent.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.Stat(); err != nil {
		t.Fatalf("closing other handles invalidated a descendant: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if count := projectDirectoryHandles(t, base, project, filepath.Join(project, "nested")); count != 0 {
		t.Fatalf("closed descendants left %d directory handles", count)
	}
}

func TestOpenProjectRejectsClosedBases(t *testing.T) {
	base := t.TempDir()
	root := openRoot(t, base, true)
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", "missing", "missing/nested"} {
		directory, err := root.OpenProject(path)
		if directory != nil {
			retainDirectory(t, directory)
			t.Fatal("closed base returned a project handle")
		}
		if !errors.Is(err, os.ErrClosed) {
			t.Fatalf("closed base failure changed: %v", err)
		}
	}
	for _, path := range []string{"..", "a//b", "a\x00b", string([]byte{0xff})} {
		directory, err := root.OpenProject(path)
		if directory != nil {
			retainDirectory(t, directory)
			t.Fatal("invalid path on a closed base returned a handle")
		}
		requireCode(t, err, "ROOT_RELATIVE_PATH_INVALID", 400)
	}
	entries, err := os.ReadDir(base)
	if err != nil || len(entries) != 0 {
		t.Fatalf("closed-base operations changed its contents: %v, %v", entries, err)
	}
}

func TestOpenProjectClosesTemporaryHandlesOnFailure(t *testing.T) {
	base := filepath.Join(t.TempDir(), "base")
	project := filepath.Join(base, "project")
	blocked := filepath.Join(project, "writable")
	makeDirectory(t, base, 0o755)
	makeDirectory(t, project, 0o755)
	makeDirectory(t, blocked, 0o777)
	if err := os.WriteFile(filepath.Join(project, "file"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(blocked, filepath.Join(project, "link")); err != nil {
		t.Fatal(err)
	}
	root := openRoot(t, base, false)
	before := projectDirectoryHandles(t, base, project, blocked)
	for attempt := 0; attempt < 8; attempt++ {
		for _, path := range []string{"project/missing/child", "project/file/child", "project/link", "project/writable", "project/" + strings.Repeat("a", 256)} {
			directory, err := root.OpenProject(path)
			if directory != nil {
				retainDirectory(t, directory)
				t.Fatal("failed project traversal returned a handle")
			}
			if err == nil {
				t.Fatal("invalid project traversal succeeded")
			}
		}
	}
	if after := projectDirectoryHandles(t, base, project, blocked); after != before {
		t.Fatalf("failed traversal leaked pinned directory handles: before %d, after %d", before, after)
	}
	if _, err := root.Stat(); err != nil {
		t.Fatalf("failed traversal closed the caller's base: %v", err)
	}
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if count := projectDirectoryHandles(t, base, project, blocked); count != 0 {
		t.Fatalf("cleanup left %d pinned directory handles", count)
	}
}
