package files_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/files"
)

const objectKey = "11111111-1111-4111-8111-111111111111"

func fixtureParent(t *testing.T) string {
	t.Helper()
	base := os.Getenv("FOREMAN_FILES_TEST_ROOT")
	if base == "" || !filepath.IsAbs(base) {
		t.Fatal("Foreman CI must provide an absolute FOREMAN_FILES_TEST_ROOT in fresh owned state outside temporary, workspace and harness roots")
	}
	parent, err := os.MkdirTemp(base, "managed-bytes-")
	if err != nil {
		t.Fatalf("create disposable file-storage fixture: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(parent); err != nil {
			t.Errorf("remove owned file-storage fixture: %v", err)
		}
	})
	return parent
}

func byteStorage(t *testing.T, maxBytes int64) *files.FileByteStorage {
	t.Helper()
	storage, err := files.NewFileByteStorage(filepath.Join(fixtureParent(t), "files"), maxBytes, nil)
	if err != nil {
		t.Fatal(err)
	}
	return storage
}

func byteDigest(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

// This test port accepts only the exact supplied fixture. It is not a format
// implementation, admission receipt or substitute for the pending codec tests.
func fixtureValidator(value []byte) files.TypeVerifier {
	return func(ctx context.Context, reader io.ReaderAt, maxBytes int64) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if int64(len(value)) > maxBytes {
			return errors.New("fixture exceeds the validator's byte bound")
		}
		actual := make([]byte, len(value))
		if _, err := io.ReadFull(io.NewSectionReader(reader, 0, int64(len(value))), actual); err != nil {
			return err
		}
		if !bytes.Equal(actual, value) {
			return errors.New("validator received different fixture bytes")
		}
		return nil
	}
}

func receiveBytes(t *testing.T, storage *files.FileByteStorage, key string, value []byte) files.UploadCandidate {
	t.Helper()
	candidate, err := storage.Receive(t.Context(), key, io.NopCloser(bytes.NewReader(value)), int64(len(value)), byteDigest(value), fixtureValidator(value))
	if err != nil {
		t.Fatalf("receive managed bytes: %v", err)
	}
	return candidate
}

func publishBytes(t *testing.T, storage *files.FileByteStorage, key string, value []byte) {
	t.Helper()
	candidate := receiveBytes(t, storage, key, value)
	if err := storage.Stage(t.Context(), candidate, int64(len(value)), byteDigest(value), fixtureValidator(value)); err != nil {
		t.Fatalf("stage managed bytes: %v", err)
	}
	if err := storage.Discard(candidate); err != nil {
		t.Fatalf("discard completed upload attempt: %v", err)
	}
	if err := storage.Finalize(t.Context(), key, int64(len(value)), byteDigest(value), fixtureValidator(value)); err != nil {
		t.Fatalf("finalize managed bytes: %v", err)
	}
}

func requireFileError(t *testing.T, err error, code string, status int, message string) {
	t.Helper()
	failure, ok := domainerror.As(err)
	if !ok || failure.Code != code || failure.Status != status || failure.Message != message || failure.Details != nil {
		t.Fatalf("file error = %#v, want %s/%d/%q", err, code, status, message)
	}
}

func requirePinnedBytes(t *testing.T, storage *files.FileByteStorage, key string, expected []byte) {
	t.Helper()
	snapshot, err := storage.OpenRead(t.Context(), key, int64(len(expected)), byteDigest(expected))
	if err != nil {
		t.Fatalf("open pinned bytes: %v", err)
	}
	t.Cleanup(func() {
		if err := snapshot.Close(); err != nil {
			t.Errorf("close owned read snapshot: %v", err)
		}
	})
	if len(expected) == 0 {
		return
	}
	actual, err := snapshot.Read(0, int64(len(expected)))
	if err != nil || !bytes.Equal(actual, expected) {
		t.Fatalf("pinned bytes = %q, %v; want %q", actual, err, expected)
	}
}
