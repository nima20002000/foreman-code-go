package transfer_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/transfer"
)

func digest(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func newPart(t *testing.T, byteLimit int64, chunkLimit int, hook func(transfer.SyncPoint) error) (*transfer.StagingDirectory, *transfer.StagingPart, string) {
	t.Helper()
	root := t.TempDir()
	directory, err := transfer.OpenStagingDirectory(root, hook)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := directory.Close(); err != nil {
			t.Error(err)
		}
	})
	part, err := directory.OpenPart("object", byteLimit, chunkLimit)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := part.Close(); err != nil {
			t.Error(err)
		}
	})
	return directory, part, root
}

func assertBytes(t *testing.T, root string, expected []byte) {
	t.Helper()
	actual, err := os.ReadFile(filepath.Join(root, "object.part"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expected) {
		t.Fatalf("staged bytes = %q; want %q", actual, expected)
	}
}

func appendBytes(t *testing.T, part *transfer.StagingPart, prefix, data []byte) (int64, string) {
	t.Helper()
	offset, hash, err := part.SyncChunk(context.Background(), int64(len(prefix)), digest(prefix), int64(len(prefix)), digest(data), data)
	if err != nil {
		t.Fatal(err)
	}
	want := append(bytes.Clone(prefix), data...)
	if offset != int64(len(want)) || hash != digest(want) {
		t.Fatalf("synced prefix = (%d, %s); want (%d, %s)", offset, hash, len(want), digest(want))
	}
	return offset, hash
}

func TestStagingBinaryChunksAndExactDuplicate(t *testing.T) {
	data := []byte{0, 255, '\n', 128, 'a', 0, 'z'}
	directory, part, root := newPart(t, int64(len(data)), 4, nil)
	appendBytes(t, part, nil, data[:4])
	offset, hash := appendBytes(t, part, data[:4], data[4:])
	duplicateOffset, duplicateHash, err := part.SyncChunk(context.Background(), offset, hash, 1, digest(data[1:4]), data[1:4])
	if err != nil || duplicateOffset != offset || duplicateHash != hash {
		t.Fatalf("exact duplicate = (%d, %s, %v)", duplicateOffset, duplicateHash, err)
	}
	if err := part.Verify(context.Background(), digest(data)); err != nil {
		t.Fatal(err)
	}
	if err := directory.Sync(); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, root, data)
}

func TestStagingInvalidChunksLeaveCommittedBytesUnchanged(t *testing.T) {
	cases := []struct {
		name   string
		offset int64
		data   []byte
		hash   string
		want   error
	}{
		{name: "empty", offset: 4, data: nil, hash: digest(nil), want: transfer.ErrChunk},
		{name: "chunk limit", offset: 4, data: []byte("abcde"), hash: digest([]byte("abcde")), want: transfer.ErrChunk},
		{name: "negative offset", offset: -1, data: []byte("x"), hash: digest([]byte("x")), want: transfer.ErrChunk},
		{name: "invalid digest", offset: 4, data: []byte("x"), hash: "bad", want: transfer.ErrChunk},
		{name: "incorrect digest", offset: 4, data: []byte("x"), hash: digest([]byte("y")), want: transfer.ErrChunk},
		{name: "allocation", offset: 7, data: []byte("xy"), hash: digest([]byte("xy")), want: transfer.ErrAllocation},
		{name: "gap", offset: 5, data: []byte("x"), hash: digest([]byte("x")), want: transfer.ErrOffset},
		{name: "overlap", offset: 3, data: []byte("de"), hash: digest([]byte("de")), want: transfer.ErrOffset},
		{name: "conflicting duplicate", offset: 1, data: []byte("xx"), hash: digest([]byte("xx")), want: transfer.ErrDuplicate},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, part, root := newPart(t, 8, 4, nil)
			committed := []byte("abcd")
			appendBytes(t, part, nil, committed)
			_, _, err := part.SyncChunk(context.Background(), 4, digest(committed), test.offset, test.hash, test.data)
			if !errors.Is(err, test.want) {
				t.Fatalf("invalid chunk error = %v; want %v", err, test.want)
			}
			assertBytes(t, root, committed)
		})
	}
}

func TestStagingReconcileTruncatesOnlyUncommittedTail(t *testing.T) {
	directory, part, root := newPart(t, 6, 3, nil)
	appendBytes(t, part, nil, []byte("abc"))
	appendBytes(t, part, []byte("abc"), []byte("def"))
	if err := part.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := directory.OpenPart("object", 6, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := reopened.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := reopened.Reconcile(context.Background(), 3, digest([]byte("abc"))); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, root, []byte("abc"))
	appendBytes(t, reopened, []byte("abc"), []byte("def"))
	if err := reopened.Verify(context.Background(), digest([]byte("abcdef"))); err != nil {
		t.Fatal(err)
	}
}

func TestStagingCorruptCommittedPrefixFailsWithoutTruncation(t *testing.T) {
	for _, altered := range []string{"ab", "xbcdTAIL"} {
		t.Run(altered, func(t *testing.T) {
			_, part, root := newPart(t, 8, 4, nil)
			appendBytes(t, part, nil, []byte("abcd"))
			if err := os.WriteFile(filepath.Join(root, "object.part"), []byte(altered), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := part.Reconcile(context.Background(), 4, digest([]byte("abcd"))); !errors.Is(err, transfer.ErrCommittedBytes) {
				t.Fatalf("reconcile error = %v", err)
			}
			_, _, err := part.SyncChunk(context.Background(), 4, digest([]byte("abcd")), 4, digest([]byte("e")), []byte("e"))
			if !errors.Is(err, transfer.ErrCommittedBytes) {
				t.Fatalf("append with corrupt prefix error = %v", err)
			}
			assertBytes(t, root, []byte(altered))
		})
	}
}

func TestStagingFullVerificationRechecksBytesAndLength(t *testing.T) {
	_, part, root := newPart(t, 4, 4, nil)
	appendBytes(t, part, nil, []byte("abcd"))
	if err := part.Verify(context.Background(), digest([]byte("abcd"))); err != nil {
		t.Fatal(err)
	}
	for _, altered := range []string{"abce", "abc", "abcde"} {
		if err := os.WriteFile(filepath.Join(root, "object.part"), []byte(altered), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := part.Verify(context.Background(), digest([]byte("abcd"))); !errors.Is(err, transfer.ErrWholeIntegrity) {
			t.Fatalf("verification of %q error = %v", altered, err)
		}
		assertBytes(t, root, []byte(altered))
	}
}

func TestStagingEmptyObjectRejectsAdditionalBytes(t *testing.T) {
	_, part, root := newPart(t, 0, 4, nil)
	if err := part.Reconcile(context.Background(), 0, digest(nil)); err != nil {
		t.Fatal(err)
	}
	if err := part.Verify(context.Background(), digest(nil)); err != nil {
		t.Fatal(err)
	}
	_, _, err := part.SyncChunk(context.Background(), 0, digest(nil), 0, digest([]byte("x")), []byte("x"))
	if !errors.Is(err, transfer.ErrAllocation) {
		t.Fatalf("zero-byte allocation error = %v", err)
	}
	assertBytes(t, root, nil)
}

func TestStagingDataSyncFailureReturnsNoPrefix(t *testing.T) {
	failure := errors.New("injected data fsync failure")
	fail := true
	_, part, root := newPart(t, 4, 4, func(point transfer.SyncPoint) error {
		if fail && point == transfer.SyncData {
			return failure
		}
		return nil
	})
	offset, hash, err := part.SyncChunk(context.Background(), 0, digest(nil), 0, digest([]byte("abcd")), []byte("abcd"))
	if !errors.Is(err, failure) || offset != 0 || hash != "" {
		t.Fatalf("failed sync returned (%d, %s, %v)", offset, hash, err)
	}
	assertBytes(t, root, []byte("abcd"))
	fail = false
	if err := part.Reconcile(context.Background(), 0, digest(nil)); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, root, nil)
	appendBytes(t, part, nil, []byte("abcd"))
}

func TestStagingCancellationDoesNotAcknowledgeData(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelDuringSync := false
	_, part, root := newPart(t, 4, 4, func(point transfer.SyncPoint) error {
		if cancelDuringSync && point == transfer.SyncData {
			cancel()
		}
		return nil
	})
	before, cancelBefore := context.WithCancel(context.Background())
	cancelBefore()
	_, _, err := part.SyncChunk(before, 0, digest(nil), 0, digest([]byte("abcd")), []byte("abcd"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled operation error = %v", err)
	}
	assertBytes(t, root, nil)
	cancelDuringSync = true
	offset, hash, err := part.SyncChunk(ctx, 0, digest(nil), 0, digest([]byte("abcd")), []byte("abcd"))
	if !errors.Is(err, context.Canceled) || offset != 0 || hash != "" {
		t.Fatalf("cancelled sync returned (%d, %s, %v)", offset, hash, err)
	}
	assertBytes(t, root, []byte("abcd"))
	cancelDuringSync = false
	if err := part.Reconcile(context.Background(), 0, digest(nil)); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, root, nil)
}

func TestStagingDirectorySyncPropagatesFailure(t *testing.T) {
	failure := errors.New("injected directory fsync failure")
	fail := true
	directory, part, root := newPart(t, 4, 4, func(point transfer.SyncPoint) error {
		if fail && point == transfer.SyncDirectory {
			return failure
		}
		return nil
	})
	appendBytes(t, part, nil, []byte("abcd"))
	if err := directory.Sync(); !errors.Is(err, failure) {
		t.Fatalf("directory sync error = %v", err)
	}
	fail = false
	if err := directory.Sync(); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, root, []byte("abcd"))
}

func TestStagingCloseRetainsBytesAndRejectsFurtherUse(t *testing.T) {
	directory, part, root := newPart(t, 4, 4, nil)
	appendBytes(t, part, nil, []byte("abcd"))
	if err := part.Close(); err != nil {
		t.Fatal(err)
	}
	if err := directory.Close(); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, root, []byte("abcd"))
	if err := part.Verify(context.Background(), digest([]byte("abcd"))); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed part error = %v", err)
	}
	if _, err := directory.OpenPart("next", 4, 4); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed directory open error = %v", err)
	}
	if err := directory.Sync(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed directory sync error = %v", err)
	}
}
