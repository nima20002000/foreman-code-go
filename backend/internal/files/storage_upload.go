package files

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Receive writes one independent attempt. size and digest are scalar pins from
// the caller's generated revision; filenames/media types remain in that caller's
// bound TypeVerifier. A canceled request closes its source to unblock a read.
func (storage *FileByteStorage) Receive(ctx context.Context, key string, source io.ReadCloser, size int64, digest string, verifyType TypeVerifier) (candidate UploadCandidate, err error) {
	if err := requireVerifier(verifyType); err != nil {
		return candidate, err
	}
	if source == nil {
		return candidate, errors.New("managed file storage requires an upload source")
	}
	if err := storage.Initialize(); err != nil {
		return candidate, err
	}
	if err := storage.checkSize(size); err != nil {
		return candidate, err
	}
	staging, err := storage.staging(key)
	if err != nil {
		return candidate, err
	}
	if err := privateDirectory(staging); err != nil {
		return candidate, err
	}
	attempt, err := attemptID()
	if err != nil {
		return candidate, err
	}
	candidate = UploadCandidate{StorageKey: key, AttemptID: attempt}
	path, err := storage.candidate(candidate)
	if err != nil {
		return candidate, err
	}
	handle, err := openNoFollow(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return candidate, err
	}
	complete := false
	aborted := make(chan error, 1)
	stopAbort := context.AfterFunc(ctx, func() { aborted <- source.Close() })
	defer func() {
		if !stopAbort() {
			err = errors.Join(err, <-aborted)
		}
		err = errors.Join(err, handle.Close())
		if !complete {
			err = errors.Join(err, storage.Discard(candidate))
		}
	}()
	if err := storage.receive(ctx, source, handle, size, digest); err != nil {
		return candidate, err
	}
	if err := handle.Sync(); err != nil {
		return candidate, err
	}
	if err := verifyType(ctx, handle, storage.maxBytes); err != nil {
		return candidate, err
	}
	if err := handle.Chmod(0o400); err != nil {
		return candidate, err
	}
	if err := handle.Sync(); err != nil {
		return candidate, err
	}
	complete = true
	return candidate, nil
}

func (storage *FileByteStorage) receive(ctx context.Context, source io.Reader, handle *os.File, size int64, digest string) error {
	buffer := make([]byte, 65536)
	hash := sha256.New()
	var received int64
	for {
		if err := uploadInterruption(ctx); err != nil {
			return err
		}
		count, readError := source.Read(buffer)
		if err := uploadInterruption(ctx); err != nil {
			return err
		}
		if count > 0 {
			received += int64(count)
			if received > storage.maxBytes {
				return fileError("FILE_TOO_LARGE", "The file exceeds the permitted byte limit.", 413, nil)
			}
			if received > size {
				return fileError("FILE_SIZE_MISMATCH", "The upload exceeds its allocated byte count.", 422, nil)
			}
			hash.Write(buffer[:count])
			if err := writeBytes(handle, buffer[:count]); err != nil {
				return err
			}
		}
		if errors.Is(readError, io.EOF) {
			break
		}
		if readError != nil {
			return readError
		}
	}
	if err := uploadInterruption(ctx); err != nil {
		return err
	}
	if received != size {
		return fileError("FILE_SIZE_MISMATCH", "The upload ended before its allocated byte count.", 422, nil)
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return fileError("FILE_HASH_MISMATCH", "The uploaded SHA-256 differs from its allocation.", 422, nil)
	}
	return nil
}

func uploadInterruption(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fileError("FILE_UPLOAD_INTERRUPTED", "Upload was interrupted; retry the same request.", 408, err)
	}
	return nil
}

func writeBytes(handle *os.File, bytes []byte) error {
	for len(bytes) > 0 {
		written, err := handle.Write(bytes)
		if err != nil {
			return err
		}
		if written == 0 {
			return errors.New("managed storage made no write progress")
		}
		bytes = bytes[written:]
	}
	return nil
}

func (storage *FileByteStorage) verify(ctx context.Context, handle *os.File, size int64, digest string, verifyType TypeVerifier) error {
	if err := storage.checkSize(size); err != nil {
		return err
	}
	stat, err := handle.Stat()
	if err != nil {
		return err
	}
	if stat.Size() != size {
		return fileError("FILE_SIZE_MISMATCH", "The uploaded byte count differs from its allocation.", 422, nil)
	}
	hash := sha256.New()
	copied, err := io.Copy(hash, io.NewSectionReader(handle, 0, size))
	if err != nil {
		return err
	}
	if copied != size {
		return fileError("FILE_TYPE_INVALID", "The file is truncated.", 415, nil)
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return fileError("FILE_HASH_MISMATCH", "The uploaded SHA-256 differs from its allocation.", 422, nil)
	}
	if verifyType != nil {
		return verifyType(ctx, handle, storage.maxBytes)
	}
	return nil
}

// Stage links verified staging without overwrite. Existing attempts must match
// the same size, digest and type policy before a retry may reuse them.
func (storage *FileByteStorage) Stage(ctx context.Context, candidate UploadCandidate, size int64, digest string, verifyType TypeVerifier) error {
	if err := requireVerifier(verifyType); err != nil {
		return err
	}
	if err := storage.Initialize(); err != nil {
		return err
	}
	path, err := storage.candidate(candidate)
	if err != nil {
		return err
	}
	verified, err := storage.verified(candidate.StorageKey)
	if err != nil {
		return err
	}
	if err := storage.linkVerified(ctx, path, verified, size, digest, verifyType); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(verified)); err != nil {
		return err
	}
	return syncDirectory(filepath.Join(storage.root, "staging"))
}

func (storage *FileByteStorage) linkVerified(ctx context.Context, source, target string, size int64, digest string, verifyType TypeVerifier) error {
	err := os.Link(source, target)
	if !errors.Is(err, os.ErrExist) {
		return err
	}
	return storage.verifyPath(ctx, target, size, digest, verifyType)
}

func (storage *FileByteStorage) verifyPath(ctx context.Context, path string, size int64, digest string, verifyType TypeVerifier) (err error) {
	handle, err := openRegular(path)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, handle.Close()) }()
	return storage.verify(ctx, handle, size, digest, verifyType)
}

// Finalize repairs a retry after link/fsync even if the calling database
// transaction had not committed. It never overwrites an existing object.
func (storage *FileByteStorage) Finalize(ctx context.Context, key string, size int64, digest string, verifyType TypeVerifier) error {
	if err := requireVerifier(verifyType); err != nil {
		return err
	}
	if err := storage.Initialize(); err != nil {
		return err
	}
	object, err := storage.object(key)
	if err != nil {
		return err
	}
	verified, err := storage.verified(key)
	if err != nil {
		return err
	}
	existing, err := openRegular(object)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if existing != nil {
		if err := storage.verifyAndClose(ctx, existing, size, digest, verifyType); err != nil {
			return err
		}
	} else {
		staged, err := openRegular(verified)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return fileError("FILE_UPLOAD_INCOMPLETE", "Upload verified bytes before finalizing.", 409, err)
			}
			return err
		}
		if err := storage.verifyAndClose(ctx, staged, size, digest, verifyType); err != nil {
			return err
		}
		if err := storage.linkVerified(ctx, verified, object, size, digest, verifyType); err != nil {
			return err
		}
	}
	if err := syncDirectory(filepath.Join(storage.root, "objects")); err != nil {
		return err
	}
	if err := removeFile(verified); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(verified)); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (storage *FileByteStorage) verifyAndClose(ctx context.Context, handle *os.File, size int64, digest string, verifyType TypeVerifier) error {
	err := storage.verify(ctx, handle, size, digest, verifyType)
	return errors.Join(err, handle.Close())
}

func (storage *FileByteStorage) Discard(candidate UploadCandidate) error {
	path, err := storage.candidate(candidate)
	if err != nil {
		return err
	}
	return removeFile(path)
}

// RemoveUnsent may only be called after the service cancels a pending
// allocation, never for an accepted ready file. It adds no deletion capability.
func (storage *FileByteStorage) RemoveUnsent(key string) error {
	if err := storage.Initialize(); err != nil {
		return err
	}
	staging, err := storage.staging(key)
	if err != nil {
		return err
	}
	object, err := storage.object(key)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	if err := removeFile(object); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Join(storage.root, "objects")); err != nil {
		return err
	}
	return syncDirectory(filepath.Join(storage.root, "staging"))
}

func removeFile(path string) error {
	if err := os.Remove(path); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func attemptID() (string, error) {
	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		return "", err
	}
	identity[6] = (identity[6] & 0x0f) | 0x40
	identity[8] = (identity[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", identity[:4], identity[4:6], identity[6:8], identity[8:10], identity[10:]), nil
}
