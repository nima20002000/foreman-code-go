package files_test

import (
	"bytes"
	"testing"
)

func TestManagedBytesSnapshotEnforcesPinsRangesAndClose(t *testing.T) {
	storage := byteStorage(t, 1024)
	value := []byte("0123456789")
	publishBytes(t, storage, objectKey, value)
	_, err := storage.OpenRead(t.Context(), objectKey, 9, byteDigest(value))
	requireFileError(t, err, "FILE_SIZE_MISMATCH", 422, "The uploaded byte count differs from its allocation.")
	_, err = storage.OpenRead(t.Context(), objectKey, 10, byteDigest([]byte("9876543210")))
	requireFileError(t, err, "FILE_HASH_MISMATCH", 422, "The uploaded SHA-256 differs from its allocation.")
	snapshot, err := storage.OpenRead(t.Context(), objectKey, 10, byteDigest(value))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := snapshot.Close(); err != nil {
			t.Errorf("close test snapshot: %v", err)
		}
	})
	for _, bounds := range [][2]int64{{-1, 1}, {0, 0}, {10, 1}, {9, 2}, {0, 9_007_199_254_740_992}} {
		_, err := snapshot.Read(bounds[0], bounds[1])
		requireFileError(t, err, "FILE_RANGE_INVALID", 416, "The range is outside the pinned file.")
	}
	for _, bounds := range [][2]int64{{7, 3}, {0, 3}, {3, 4}} {
		actual, err := snapshot.Read(bounds[0], bounds[1])
		expected := value[bounds[0] : bounds[0]+bounds[1]]
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("positioned read = %q %v; want %q", actual, err, expected)
		}
	}
	for i := 0; i < 2; i++ {
		if err := snapshot.Close(); err != nil {
			t.Fatalf("snapshot close/retry: %v", err)
		}
	}
	_, err = snapshot.Read(0, 1)
	requireFileError(t, err, "FILE_BYTES_UNAVAILABLE", 410, "The pinned file changed during delivery.")
}

func TestManagedBytesCanceledAllocationCleansCrashPublication(t *testing.T) {
	storage := byteStorage(t, 1024)
	value := []byte("hello")
	// Simulate bytes linked before an allocation's database commit. No service
	// has accepted a ready record; cancellation may still remove these bytes.
	publishBytes(t, storage, objectKey, value)
	snapshot, err := storage.OpenRead(t.Context(), objectKey, 5, byteDigest(value))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := snapshot.Close(); err != nil {
			t.Errorf("close canceled snapshot: %v", err)
		}
	})
	for i := 0; i < 2; i++ {
		if err := storage.RemoveUnsent(objectKey); err != nil {
			t.Fatalf("cancel/retry cleanup: %v", err)
		}
	}
	_, err = snapshot.Read(0, 5)
	requireFileError(t, err, "FILE_BYTES_UNAVAILABLE", 410, "The pinned file changed during delivery.")
	_, err = storage.OpenRead(t.Context(), objectKey, 5, byteDigest(value))
	requireFileError(t, err, "FILE_BYTES_UNAVAILABLE", 410, "The pinned file bytes are unavailable.")
}
