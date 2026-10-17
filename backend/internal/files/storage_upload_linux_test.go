package files_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/files"
)

func TestManagedBytesUploadFinalizeAndReopen(t *testing.T) {
	storage := byteStorage(t, 1024)
	value := []byte("# Managed bytes\nUnicode: λ ✓\n")
	candidate := receiveBytes(t, storage, objectKey, value)
	_, err := storage.OpenRead(t.Context(), objectKey, int64(len(value)), byteDigest(value))
	requireFileError(t, err, "FILE_BYTES_UNAVAILABLE", 410, "The pinned file bytes are unavailable.")
	err = storage.Finalize(t.Context(), objectKey, int64(len(value)), byteDigest(value), fixtureValidator(value))
	requireFileError(t, err, "FILE_UPLOAD_INCOMPLETE", 409, "Upload verified bytes before finalizing.")
	for i := 0; i < 2; i++ {
		if err := storage.Stage(t.Context(), candidate, int64(len(value)), byteDigest(value), fixtureValidator(value)); err != nil {
			t.Fatalf("stage/retry: %v", err)
		}
	}
	if err := storage.Discard(candidate); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := storage.Finalize(t.Context(), objectKey, int64(len(value)), byteDigest(value), fixtureValidator(value)); err != nil {
			t.Fatalf("finalize/retry: %v", err)
		}
	}
	reopened, err := files.NewFileByteStorage(storage.Root(), 1024, nil)
	if err != nil {
		t.Fatal(err)
	}
	requirePinnedBytes(t, reopened, objectKey, value)
}

func TestManagedBytesRejectsMismatchedAndOversizedUploads(t *testing.T) {
	value := []byte("hello")
	cases := []struct {
		name    string
		input   []byte
		size    int64
		digest  string
		code    string
		status  int
		message string
	}{
		{"too large allocation", value, 9, byteDigest(value), "FILE_TOO_LARGE", 413, "The file exceeds the permitted byte limit."},
		{"negative allocation", value, -1, byteDigest(value), "FILE_TOO_LARGE", 413, "The file exceeds the permitted byte limit."},
		{"too many bytes", []byte("123456789"), 5, byteDigest(value), "FILE_TOO_LARGE", 413, "The file exceeds the permitted byte limit."},
		{"over allocation", value, 4, byteDigest(value), "FILE_SIZE_MISMATCH", 422, "The upload exceeds its allocated byte count."},
		{"short upload", value[:4], 5, byteDigest(value), "FILE_SIZE_MISMATCH", 422, "The upload ended before its allocated byte count."},
		{"wrong hash", []byte("jello"), 5, byteDigest(value), "FILE_HASH_MISMATCH", 422, "The uploaded SHA-256 differs from its allocation."},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			storage := byteStorage(t, 8)
			candidate, err := storage.Receive(t.Context(), objectKey, io.NopCloser(bytes.NewReader(test.input)), test.size, test.digest, fixtureValidator(value))
			requireFileError(t, err, test.code, test.status, test.message)
			if candidate.AttemptID != "" {
				if err := storage.Stage(t.Context(), candidate, 5, byteDigest(value), fixtureValidator(value)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("rejected upload remained publishable: %v", err)
				}
			}
			err = storage.Finalize(t.Context(), objectKey, 5, byteDigest(value), fixtureValidator(value))
			requireFileError(t, err, "FILE_UPLOAD_INCOMPLETE", 409, "Upload verified bytes before finalizing.")
		})
	}
}

func TestManagedBytesRequiresValidatorAndDiscardsDeniedUpload(t *testing.T) {
	storage := byteStorage(t, 1024)
	value := []byte("hello")
	_, err := storage.Receive(t.Context(), objectKey, io.NopCloser(bytes.NewReader(value)), 5, byteDigest(value), nil)
	if err == nil {
		t.Fatal("receive admitted bytes without a type validator")
	}
	denial := domainerror.New("FILE_TYPE_INVALID", "The bytes do not match the declared file type.", 415, nil)
	validator := func(context.Context, io.ReaderAt, int64) error { return denial }
	candidate, err := storage.Receive(t.Context(), objectKey, io.NopCloser(bytes.NewReader(value)), 5, byteDigest(value), validator)
	requireFileError(t, err, denial.Code, denial.Status, denial.Message)
	if err := storage.Stage(t.Context(), candidate, 5, byteDigest(value), fixtureValidator(value)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("type-rejected candidate remained publishable: %v", err)
	}
	valid := receiveBytes(t, storage, objectKey, value)
	if err := storage.Stage(t.Context(), valid, 5, byteDigest(value), nil); err == nil {
		t.Fatal("stage admitted bytes without a type validator")
	}
	if err := storage.Finalize(t.Context(), objectKey, 5, byteDigest(value), nil); err == nil {
		t.Fatal("finalize admitted bytes without a type validator")
	}
	err = storage.Finalize(t.Context(), objectKey, 5, byteDigest(value), fixtureValidator(value))
	requireFileError(t, err, "FILE_UPLOAD_INCOMPLETE", 409, "Upload verified bytes before finalizing.")
}

func TestManagedBytesRetryNeverOverwritesPublishedContent(t *testing.T) {
	storage := byteStorage(t, 1024)
	firstBytes, secondBytes := []byte("first"), []byte("later")
	first := receiveBytes(t, storage, objectKey, firstBytes)
	second := receiveBytes(t, storage, objectKey, secondBytes)
	if first.AttemptID == second.AttemptID {
		t.Fatal("retry reused the active upload attempt")
	}
	if err := storage.Stage(t.Context(), first, 5, byteDigest(firstBytes), fixtureValidator(firstBytes)); err != nil {
		t.Fatal(err)
	}
	err := storage.Stage(t.Context(), second, 5, byteDigest(secondBytes), fixtureValidator(secondBytes))
	requireFileError(t, err, "FILE_HASH_MISMATCH", 422, "The uploaded SHA-256 differs from its allocation.")
	if err := storage.Discard(first); err != nil {
		t.Fatal(err)
	}
	if err := storage.Finalize(t.Context(), objectKey, 5, byteDigest(firstBytes), fixtureValidator(firstBytes)); err != nil {
		t.Fatal(err)
	}
	err = storage.Finalize(t.Context(), objectKey, 5, byteDigest(secondBytes), fixtureValidator(secondBytes))
	requireFileError(t, err, "FILE_HASH_MISMATCH", 422, "The uploaded SHA-256 differs from its allocation.")
	requirePinnedBytes(t, storage, objectKey, firstBytes)
}

type startedReader struct {
	io.ReadCloser
	once    sync.Once
	started chan struct{}
}

func (reader *startedReader) Read(value []byte) (int, error) {
	reader.once.Do(func() { close(reader.started) })
	return reader.ReadCloser.Read(value)
}

func TestManagedBytesCancellationUnblocksReadAndAllowsRetry(t *testing.T) {
	storage := byteStorage(t, 1024)
	value := []byte("hello")
	reader, writer := io.Pipe()
	t.Cleanup(func() {
		if err := writer.Close(); err != nil {
			t.Errorf("close test upload writer: %v", err)
		}
	})
	source := &startedReader{ReadCloser: reader, started: make(chan struct{})}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := storage.Receive(ctx, objectKey, source, 5, byteDigest(value), fixtureValidator(value))
		result <- err
	}()
	select {
	case <-source.started:
	case err := <-result:
		t.Fatalf("upload returned before receiving: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not start its source read")
	}
	cancel()
	select {
	case err := <-result:
		requireFileError(t, err, "FILE_UPLOAD_INTERRUPTED", 408, "Upload was interrupted; retry the same request.")
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not unblock the source read")
	}
	publishBytes(t, storage, objectKey, value)
	requirePinnedBytes(t, storage, objectKey, value)
}

func TestManagedBytesAcceptsEmptyValidatedContent(t *testing.T) {
	storage := byteStorage(t, 1024)
	value := []byte{}
	publishBytes(t, storage, objectKey, value)
	requirePinnedBytes(t, storage, objectKey, value)
}
