package transfer_test

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/transfer"
)

func TestStagingCreatesPrivateDirectoriesAndFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "new", "private")
	directory, err := transfer.OpenStagingDirectory(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := directory.Close(); err != nil {
			t.Error(err)
		}
	}()
	part, err := directory.OpenPart("object", 4, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := part.Close(); err != nil {
			t.Error(err)
		}
	}()
	appendBytes(t, part, nil, []byte("abcd"))
	for path, permissions := range map[string]os.FileMode{root: 0o700, filepath.Join(root, "object.part"): 0o600} {
		stat, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if stat.Mode().Perm() != permissions {
			t.Fatalf("staging permissions = %o; want %o", stat.Mode().Perm(), permissions)
		}
	}
}

func TestStagingRejectsUnsafeRoots(t *testing.T) {
	for _, name := range []string{"relative", "dot", "dot-dot", "symlink", "public root", "writable ancestor"} {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			root := filepath.Join(base, "stage")
			switch name {
			case "relative":
				root = "relative-stage"
			case "dot":
				root = base + "/./stage"
			case "dot-dot":
				root = base + "/../stage"
			case "symlink":
				outside := t.TempDir()
				if err := os.Symlink(outside, filepath.Join(base, "alias")); err != nil {
					t.Fatal(err)
				}
				root = filepath.Join(base, "alias", "stage")
			case "public root":
				if err := os.Mkdir(root, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(root, 0o755); err != nil {
					t.Fatal(err)
				}
			case "writable ancestor":
				if err := os.Chmod(base, 0o777); err != nil {
					t.Fatal(err)
				}
			}
			directory, err := transfer.OpenStagingDirectory(root, nil)
			if err == nil {
				if closeErr := directory.Close(); closeErr != nil {
					t.Error(closeErr)
				}
				t.Fatal("unsafe staging root accepted")
			}
		})
	}
}

func TestStagingRejectsUnsafeNamesAndLimitsWithoutCreatingParts(t *testing.T) {
	root := t.TempDir()
	directory, err := transfer.OpenStagingDirectory(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := directory.Close(); err != nil {
			t.Error(err)
		}
	}()
	for _, name := range []string{"", ".", "..", "../escape", "child/file", "child\\file", "nul\x00name"} {
		if part, err := directory.OpenPart(name, 4, 4); err == nil {
			if closeErr := part.Close(); closeErr != nil {
				t.Error(closeErr)
			}
			t.Fatalf("unsafe filename %q accepted", name)
		}
	}
	for _, limits := range [][2]int64{{-1, 4}, {4, 0}, {4, -1}} {
		if part, err := directory.OpenPart("invalid", limits[0], int(limits[1])); err == nil {
			if closeErr := part.Close(); closeErr != nil {
				t.Error(closeErr)
			}
			t.Fatalf("invalid staging limits %v accepted", limits)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("invalid requests created %d files", len(entries))
	}
}

func TestStagingRejectsUnsafeExistingPartFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "public", "fifo", "directory"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(target, []byte("outside"), 0o600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "object.part")
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink(target, path)
			case "hardlink":
				err = os.Link(target, path)
			case "public":
				err = os.WriteFile(path, []byte("public"), 0o644)
				if err == nil {
					err = os.Chmod(path, 0o644)
				}
			case "fifo":
				err = syscall.Mkfifo(path, 0o600)
			case "directory":
				err = os.Mkdir(path, 0o700)
			}
			if err != nil {
				t.Fatal(err)
			}
			directory, err := transfer.OpenStagingDirectory(root, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := directory.Close(); err != nil {
					t.Error(err)
				}
			}()
			part, err := directory.OpenPart("object", 8, 4)
			if err == nil {
				if closeErr := part.Close(); closeErr != nil {
					t.Error(closeErr)
				}
				t.Fatalf("unsafe %s part accepted", kind)
			}
			outside, err := os.ReadFile(target)
			if err != nil || string(outside) != "outside" {
				t.Fatalf("outside bytes changed: %q, %v", outside, err)
			}
		})
	}
}

func TestStagingDetectsPartHardlinkAddedAfterOpen(t *testing.T) {
	_, part, root := newPart(t, 4, 4, nil)
	linked := filepath.Join(t.TempDir(), "linked")
	if err := os.Link(filepath.Join(root, "object.part"), linked); err != nil {
		t.Fatal(err)
	}
	_, _, err := part.SyncChunk(context.Background(), 0, digest(nil), 0, digest([]byte("abcd")), []byte("abcd"))
	if err == nil {
		t.Fatal("new hardlink was accepted for writing")
	}
	assertBytes(t, root, nil)
	data, err := os.ReadFile(linked)
	if err != nil || len(data) != 0 {
		t.Fatalf("hardlinked bytes changed: %q, %v", data, err)
	}
}

func TestStagingWritesRemainPinnedAfterAncestorSwap(t *testing.T) {
	base := t.TempDir()
	ancestor := filepath.Join(base, "ancestor")
	root := filepath.Join(ancestor, "stage")
	directory, err := transfer.OpenStagingDirectory(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := directory.Close(); err != nil {
			t.Error(err)
		}
	}()
	retained := filepath.Join(base, "retained")
	if err := os.Rename(ancestor, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	part, err := directory.OpenPart("object", 4, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := part.Close(); err != nil {
			t.Error(err)
		}
	}()
	appendBytes(t, part, nil, []byte("abcd"))
	if err := directory.Sync(); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, filepath.Join(retained, "stage"), []byte("abcd"))
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("writes reached swapped ancestor: %d files", len(entries))
	}
}
