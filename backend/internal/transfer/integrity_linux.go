package transfer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"os"
	"sync"
)

var (
	ErrCommittedBytes error = &stagingFailure{reason: committedBytesFailure}
	ErrChunk          error = &stagingFailure{reason: invalidChunkFailure}
	ErrAllocation     error = &stagingFailure{reason: allocationFailure}
	ErrOffset         error = &stagingFailure{reason: offsetFailure}
	ErrDuplicate      error = &stagingFailure{reason: duplicateFailure}
	ErrWholeIntegrity error = &stagingFailure{reason: wholeIntegrityFailure}
)

// StagingPart operates on the original open file, even if its ancestors are
// renamed. Its mutex serializes this handle only; process ownership remains the
// receiver's responsibility. It never creates progress or verified receipts.
type StagingPart struct {
	mu         sync.Mutex
	file       *os.File
	byteLimit  int64
	chunkLimit int
	beforeSync func(SyncPoint) error
}

// Reconcile checks a caller-supplied committed prefix and truncates only its
// uncommitted tail. Corrupt or missing committed bytes leave the file unchanged.
// The offset and digest must come from the authoritative progress journal.
func (part *StagingPart) Reconcile(ctx context.Context, offset int64, prefixSHA256 string) error {
	part.mu.Lock()
	defer part.mu.Unlock()
	_, err := part.reconcile(ctx, offset, prefixSHA256)
	return err
}

func (part *StagingPart) reconcile(ctx context.Context, offset int64, prefixSHA256 string) (hash.Hash, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if part.file == nil {
		return nil, os.ErrClosed
	}
	if offset < 0 || offset > part.byteLimit || !validDigest(prefixSHA256) {
		return nil, ErrCommittedBytes
	}
	stat, err := regularFile(part.file)
	if err != nil {
		return nil, err
	}
	if stat.Size() < offset {
		return nil, ErrCommittedBytes
	}
	state, err := part.hashPrefix(ctx, offset)
	if err != nil {
		return nil, err
	}
	if hex.EncodeToString(state.Sum(nil)) != prefixSHA256 {
		return nil, ErrCommittedBytes
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if stat.Size() > offset {
		if err := part.file.Truncate(offset); err != nil {
			return nil, err
		}
		if err := syncAt(part.file, SyncData, part.beforeSync); err != nil {
			return nil, err
		}
	}
	return state, nil
}

// SyncChunk validates and writes one bounded chunk after reconciling the
// authoritative committed prefix. Exact duplicate ranges are compared with
// stored bytes. Returned values describe fsynced data only: the caller must
// still durably write its progress journal and directory before sending an ACK.
func (part *StagingPart) SyncChunk(ctx context.Context, committedOffset int64, prefixSHA256 string, offset int64, chunkSHA256 string, input []byte) (int64, string, error) {
	part.mu.Lock()
	defer part.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, "", err
	}
	if offset < 0 || len(input) == 0 || len(input) > part.chunkLimit || !validDigest(chunkSHA256) {
		return 0, "", ErrChunk
	}
	if int64(len(input)) > part.byteLimit || offset > part.byteLimit-int64(len(input)) {
		return 0, "", ErrAllocation
	}
	data := bytes.Clone(input)
	checksum := sha256.Sum256(data)
	if hex.EncodeToString(checksum[:]) != chunkSHA256 {
		return 0, "", ErrChunk
	}
	state, err := part.reconcile(ctx, committedOffset, prefixSHA256)
	if err != nil {
		return 0, "", err
	}
	if offset < committedOffset {
		if offset+int64(len(data)) > committedOffset {
			return 0, "", ErrOffset
		}
		previous := make([]byte, len(data))
		if err := readExactAt(part.file, previous, offset); err != nil {
			return 0, "", errors.Join(ErrDuplicate, err)
		}
		if !bytes.Equal(previous, data) {
			return 0, "", ErrDuplicate
		}
		return committedOffset, prefixSHA256, nil
	}
	if offset != committedOffset {
		return 0, "", ErrOffset
	}
	if err := part.writeChunk(ctx, data, offset); err != nil {
		return 0, "", err
	}
	if err := syncAt(part.file, SyncData, part.beforeSync); err != nil {
		return 0, "", err
	}
	if err := ctx.Err(); err != nil {
		return 0, "", err
	}
	_, _ = state.Write(data) // hash.Hash.Write cannot fail.
	return committedOffset + int64(len(data)), hex.EncodeToString(state.Sum(nil)), nil
}

func (part *StagingPart) writeChunk(ctx context.Context, data []byte, offset int64) error {
	written := 0
	for written < len(data) {
		if err := ctx.Err(); err != nil {
			return err
		}
		count, err := part.file.WriteAt(data[written:], offset+int64(written))
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrNoProgress
		}
		written += count
	}
	return nil
}

// Verify independently checks the full allocated byte count and SHA-256 on
// every call. It is an integrity check only, without receipt or admission state.
func (part *StagingPart) Verify(ctx context.Context, expectedSHA256 string) error {
	part.mu.Lock()
	defer part.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if part.file == nil {
		return os.ErrClosed
	}
	if !validDigest(expectedSHA256) {
		return ErrWholeIntegrity
	}
	stat, err := regularFile(part.file)
	if err != nil {
		return err
	}
	if stat.Size() != part.byteLimit {
		return ErrWholeIntegrity
	}
	state, err := part.hashPrefix(ctx, part.byteLimit)
	if err != nil {
		return err
	}
	if hex.EncodeToString(state.Sum(nil)) != expectedSHA256 {
		return ErrWholeIntegrity
	}
	return ctx.Err()
}

func (part *StagingPart) hashPrefix(ctx context.Context, size int64) (hash.Hash, error) {
	state := sha256.New()
	buffer := make([]byte, int(min(int64(part.chunkLimit), max(size, 1))))
	for offset := int64(0); offset < size; {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		count := int(min(int64(len(buffer)), size-offset))
		if err := readExactAt(part.file, buffer[:count], offset); err != nil {
			return nil, errors.Join(ErrCommittedBytes, err)
		}
		_, _ = state.Write(buffer[:count]) // hash.Hash.Write cannot fail.
		offset += int64(count)
	}
	return state, nil
}

func readExactAt(file *os.File, data []byte, offset int64) error {
	count, err := file.ReadAt(data, offset)
	if err != nil {
		return err
	}
	if count != len(data) {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func validDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

// Close releases the file without unlinking bytes or releasing quota.
func (part *StagingPart) Close() error {
	part.mu.Lock()
	defer part.mu.Unlock()
	if part.file == nil {
		return nil
	}
	err := part.file.Close()
	part.file = nil
	return err
}
