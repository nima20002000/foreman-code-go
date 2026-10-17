package roots_test

import (
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/roots"
)

func requireCode(t *testing.T, err error, code string, status int) {
	t.Helper()
	domain, ok := domainerror.As(err)
	if !ok || domain.Code != code || domain.Status != status {
		t.Fatalf("error = %v; want %s with status %d", err, code, status)
	}
}

func TestRelativePathPreservesAcceptedNames(t *testing.T) {
	paths := []string{
		"", "project", "folder with spaces/file.txt", ".hidden/café", "資料/資料",
		strings.Repeat("a", 1024), strings.Repeat("界", 1024), strings.Repeat("😀", 512),
		strings.Repeat("a/", 31) + "a",
	}
	for _, path := range paths {
		actual, err := roots.RelativePath(path)
		if err != nil || actual != path {
			t.Errorf("RelativePath(%q) = %q, %v; want unchanged path", path, actual, err)
		}
	}
}

func TestRelativePathRejectsTraversalAndAmbiguousNames(t *testing.T) {
	paths := []string{
		"/absolute", ".", "..", "../outside", "a/../b", "a/./b", "a//b", "a/", "/",
		"a\\b", "C:folder", "a:b", "a.", "a ", "a./b", "a /b",
		"a\x00b", "a\nb", "a\tb", "a\x7fb", "cafe\u0301", string([]byte{0xff}),
		strings.Repeat("a", 1025), strings.Repeat("😀", 513), strings.Repeat("a/", 32) + "a",
	}
	for _, path := range paths {
		actual, err := roots.RelativePath(path)
		if actual != "" {
			t.Errorf("RelativePath(%q) returned rejected path %q", path, actual)
		}
		requireCode(t, err, "ROOT_RELATIVE_PATH_INVALID", 400)
	}
}
