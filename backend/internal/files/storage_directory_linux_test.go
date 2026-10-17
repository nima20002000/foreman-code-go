package files_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/files"
)

func TestManagedBytesRejectsInvalidConfiguration(t *testing.T) {
	for _, test := range []struct {
		root  string
		limit int64
	}{
		{"relative", 1},
		{"/managed-bytes", 0},
		{"/managed-bytes", -1},
		{"/managed-bytes", 9_007_199_254_740_992},
	} {
		if _, err := files.NewFileByteStorage(test.root, test.limit, nil); err == nil {
			t.Fatal("storage accepted an invalid directory or byte bound")
		}
	}
}

func TestManagedBytesRejectsTemporaryAndOverlappingRoots(t *testing.T) {
	for _, root := range []string{filepath.Join(os.TempDir(), "uncreated-managed-bytes"), "/tmp/uncreated-managed-bytes", "/var/tmp/uncreated-managed-bytes"} {
		storage, err := files.NewFileByteStorage(root, 1024, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := storage.Initialize(); err == nil || err.Error() != "File storage must be separate from temporary, workspace, and harness directories." {
			t.Fatalf("temporary-root rejection = %v", err)
		}
	}
	parent := fixtureParent(t)
	for _, excluded := range []string{parent, filepath.Join(parent, "files"), filepath.Join(parent, "files", "workspace")} {
		storage, err := files.NewFileByteStorage(filepath.Join(parent, "files"), 1024, []string{excluded})
		if err != nil {
			t.Fatal(err)
		}
		if err := storage.Initialize(); err == nil || err.Error() != "File storage must be separate from temporary, workspace, and harness directories." {
			t.Fatalf("overlapping-root rejection = %v", err)
		}
	}
}

func TestManagedBytesRejectsSymlinkAndPublicDirectories(t *testing.T) {
	parent := fixtureParent(t)
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Fatal(err)
	}
	storage, err := files.NewFileByteStorage(filepath.Join(alias, "files"), 1024, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Initialize(); err == nil || err.Error() != "File storage must not traverse symbolic links." {
		t.Fatalf("symlink-root rejection = %v", err)
	}
	root := filepath.Join(parent, "public")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	storage, err = files.NewFileByteStorage(root, 1024, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Initialize(); err == nil || err.Error() != "File storage directories must be private, owned directories, not symbolic links." {
		t.Fatalf("public-directory rejection = %v", err)
	}
}

func TestManagedBytesRejectsHostPathsAsStorageKeys(t *testing.T) {
	storage := byteStorage(t, 1024)
	for _, key := range []string{"", "../escape", "/absolute", "UPPERCASE-1111-4111-8111-111111111111"} {
		if err := storage.RemoveUnsent(key); err == nil || err.Error() != "Invalid internal storage key." {
			t.Fatalf("invalid-key rejection = %v", err)
		}
	}
}
