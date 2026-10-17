//go:build linux

package roots_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/roots"
)

func makeDirectory(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Mkdir(path, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func retainDirectory(t *testing.T, directory *roots.Directory) *roots.Directory {
	t.Helper()
	t.Cleanup(func() {
		if err := directory.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			t.Error(err)
		}
	})
	return directory
}

func openRoot(t *testing.T, path string, privateOnly bool) *roots.Directory {
	t.Helper()
	directory, err := roots.OpenPrivateRoot(path, privateOnly)
	if err != nil {
		t.Fatal(err)
	}
	return retainDirectory(t, directory)
}

func openChild(t *testing.T, parent *roots.Directory, name string, create bool) *roots.Directory {
	t.Helper()
	directory, err := parent.OpenChild(name, create)
	if err != nil {
		t.Fatal(err)
	}
	return retainDirectory(t, directory)
}

func sameDirectory(t *testing.T, left, right *roots.Directory, expected bool) {
	t.Helper()
	same, err := left.SameDirectory(right)
	if err != nil || same != expected {
		t.Fatalf("SameDirectory = %v, %v; want %v", same, err, expected)
	}
}

func TestOpenPrivateRootRejectsCanonicalAliases(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "project")
	makeDirectory(t, path, 0o700)
	if err := os.Symlink(path, filepath.Join(base, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(base, filepath.Join(base, "parent-alias")); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{
		"relative", path + "/", path + "/.", path + "/../project",
		filepath.Join(base, "alias"), filepath.Join(base, "parent-alias", "project"),
	} {
		directory, err := roots.OpenPrivateRoot(candidate, true)
		if directory != nil {
			retainDirectory(t, directory)
			t.Errorf("opened ambiguous root %q", candidate)
		}
		requireCode(t, err, "SOURCE_FILESYSTEM_UNSUPPORTED", 422)
	}
}

func TestOpenPrivateRootHonorsPrivateAndProtectedModes(t *testing.T) {
	cases := []struct {
		name        string
		mode        os.FileMode
		privateOnly bool
		accepted    bool
	}{
		{"private", 0o700, true, true},
		{"protected", 0o755, false, true},
		{"readable base", 0o500, false, true},
		{"shared private root", 0o750, true, false},
		{"unwritable private root", 0o500, true, false},
		{"writable protected root", 0o770, false, false},
		{"unsearchable protected root", 0o600, false, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "root")
			makeDirectory(t, path, item.mode)
			directory, err := roots.OpenPrivateRoot(path, item.privateOnly)
			if directory != nil {
				retainDirectory(t, directory)
			}
			if item.accepted {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, "SOURCE_ROOT_NOT_PRIVATE", 400)
			}
			info, statErr := os.Stat(path)
			if statErr != nil || info.Mode().Perm() != item.mode {
				t.Fatalf("root permissions changed during validation: %v, %v", info, statErr)
			}
		})
	}
}

func TestOpenPrivateRootRechecksAncestorPermissions(t *testing.T) {
	ancestor := filepath.Join(t.TempDir(), "ancestor")
	makeDirectory(t, ancestor, 0o700)
	path := filepath.Join(ancestor, "root")
	makeDirectory(t, path, 0o700)
	openRoot(t, path, true)
	if err := os.Chmod(ancestor, 0o777); err != nil {
		t.Fatal(err)
	}
	directory, err := roots.OpenPrivateRoot(path, true)
	if directory != nil {
		retainDirectory(t, directory)
	}
	requireCode(t, err, "SOURCE_FILESYSTEM_UNSUPPORTED", 422)
}

func TestOpenChildCreatesOnlyPrivateDirectories(t *testing.T) {
	path := t.TempDir()
	root := openRoot(t, path, true)
	child := openChild(t, root, "capture", true)
	info, err := child.Stat()
	if err != nil || info.Mode().Perm() != 0o700 || !info.IsDir() {
		t.Fatalf("child metadata = %v, %v", info, err)
	}
	sameDirectory(t, child, openChild(t, root, "capture", false), true)
	sameDirectory(t, child, root, false)
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 1 || entries[0].Name() != "capture" {
		t.Fatalf("created entries = %v, %v", entries, err)
	}
}

func TestOpenChildRejectsTraversalSymlinksAndSharedEntries(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	makeDirectory(t, path, 0o700)
	makeDirectory(t, outside, 0o700)
	root := openRoot(t, path, true)
	makeDirectory(t, filepath.Join(path, "shared"), 0o750)
	if err := os.Symlink(outside, filepath.Join(path, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "file"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", ".", "..", "../outside", "nested/child", "/absolute", "link", "file", "shared"} {
		directory, err := root.OpenChild(name, true)
		if directory != nil {
			retainDirectory(t, directory)
		}
		if err == nil {
			t.Fatalf("OpenChild(%q) escaped its private directory boundary", name)
		}
		if name == "shared" {
			requireCode(t, err, "SOURCE_DIRECTORY_NOT_PRIVATE", 400)
		}
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("outside directory was changed: %v, %v", entries, err)
	}
}

func TestOpenChildStaysPinnedAfterParentReplacement(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "root")
	moved := filepath.Join(base, "moved")
	makeDirectory(t, path, 0o700)
	root := openRoot(t, path, true)
	before := openChild(t, root, "capture", true)
	if err := os.Rename(path, moved); err != nil {
		t.Fatal(err)
	}
	makeDirectory(t, path, 0o700)
	replacement := openRoot(t, path, true)
	replacementChild := openChild(t, replacement, "capture", true)
	after := openChild(t, root, "capture", false)
	sameDirectory(t, before, after, true)
	sameDirectory(t, after, replacementChild, false)
	sameDirectory(t, root, replacement, false)
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := after.Stat(); err != nil {
		t.Fatalf("closing a parent invalidated its child: %v", err)
	}
}

func TestEntryParentCreatesParentsAndPreservesRootOwnership(t *testing.T) {
	path := t.TempDir()
	root := openRoot(t, path, true)
	parent, leaf, err := root.EntryParent("capture/source/readme.txt", true)
	if err != nil {
		t.Fatal(err)
	}
	retainDirectory(t, parent)
	if leaf != "readme.txt" {
		t.Fatalf("leaf = %q", leaf)
	}
	info, err := parent.Stat()
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(filepath.Join(path, "capture", "source"))
	if err != nil || !os.SameFile(info, expected) {
		t.Fatalf("parent does not identify the created directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(path, "capture", "source", leaf)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("EntryParent created its leaf: %v", err)
	}
	borrowed, leaf, err := root.EntryParent("readme.txt", false)
	if err != nil || leaf != "readme.txt" {
		t.Fatalf("root parent = %q, %v", leaf, err)
	}
	retainDirectory(t, borrowed)
	sameDirectory(t, root, borrowed, true)
	if err := borrowed.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := root.Stat(); err != nil {
		t.Fatalf("closing the returned parent closed the root: %v", err)
	}
}

func TestEntryParentRejectsTraversalAndSymlinkParents(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	makeDirectory(t, path, 0o700)
	makeDirectory(t, outside, 0o700)
	root := openRoot(t, path, true)
	if err := os.Symlink(outside, filepath.Join(path, "link")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", "../escaped", "capture/../../escaped", "capture//file", "link/nested/file"} {
		parent, _, err := root.EntryParent(name, true)
		if parent != nil {
			retainDirectory(t, parent)
		}
		if err == nil {
			t.Fatalf("EntryParent(%q) accepted an escaping path", name)
		}
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("outside directory was changed: %v, %v", entries, err)
	}
}

func TestClosedDirectoryCannotBeReused(t *testing.T) {
	path := t.TempDir()
	root := openRoot(t, path, true)
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := root.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed Stat = %v", err)
	}
	if _, err := root.OpenChild("capture", true); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed OpenChild = %v", err)
	}
	if _, _, err := root.EntryParent("file", false); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed EntryParent = %v", err)
	}
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("closed root was changed: %v, %v", entries, err)
	}
}
