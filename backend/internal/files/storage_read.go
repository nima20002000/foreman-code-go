package files

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

// ReadSnapshot holds one verified descriptor for bounded positioned reads.
// The caller must close it; Close is idempotent. The metadata stamp includes
// device, inode, byte size, mtime and ctime, matching frozen TS openRead.
type ReadSnapshot struct {
	handle *os.File
	size   int64
	stamp  fileStamp
	mutex  sync.Mutex
	closed bool
}

func (storage *FileByteStorage) OpenRead(ctx context.Context, key string, size int64, digest string) (*ReadSnapshot, error) {
	if err := storage.Initialize(); err != nil {
		return nil, err
	}
	path, err := storage.object(key)
	if err != nil {
		return nil, err
	}
	handle, err := openRegular(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fileError("FILE_BYTES_UNAVAILABLE", "The pinned file bytes are unavailable.", 410, err)
		}
		return nil, err
	}
	before, err := stampFile(handle)
	if err == nil {
		err = storage.verify(ctx, handle, size, digest, nil)
	}
	if err == nil {
		var after fileStamp
		after, err = stampFile(handle)
		if err == nil && after != before {
			err = fileError("FILE_HASH_MISMATCH", "The pinned file changed during verification.", 410, nil)
		}
	}
	if err != nil {
		return nil, errors.Join(err, handle.Close())
	}
	return &ReadSnapshot{handle: handle, size: size, stamp: before}, nil
}

func (snapshot *ReadSnapshot) Read(offset, length int64) ([]byte, error) {
	if offset < 0 || offset > maxSafeInteger || length < 1 || length > maxSafeInteger || offset > snapshot.size || length > snapshot.size-offset {
		return nil, fileError("FILE_RANGE_INVALID", "The range is outside the pinned file.", 416, nil)
	}
	snapshot.mutex.Lock()
	defer snapshot.mutex.Unlock()
	if err := snapshot.unchanged(); err != nil {
		return nil, err
	}
	bytes := make([]byte, int(length))
	if _, err := io.ReadFull(io.NewSectionReader(snapshot.handle, offset, length), bytes); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fileError("FILE_BYTES_UNAVAILABLE", "The pinned file is truncated.", 410, err)
		}
		return nil, err
	}
	if err := snapshot.unchanged(); err != nil {
		return nil, err
	}
	return bytes, nil
}

func (snapshot *ReadSnapshot) unchanged() error {
	if snapshot.closed {
		return fileError("FILE_BYTES_UNAVAILABLE", "The pinned file changed during delivery.", 410, nil)
	}
	now, err := stampFile(snapshot.handle)
	if err != nil {
		return err
	}
	if now != snapshot.stamp {
		return fileError("FILE_BYTES_UNAVAILABLE", "The pinned file changed during delivery.", 410, nil)
	}
	return nil
}

func (snapshot *ReadSnapshot) Close() error {
	snapshot.mutex.Lock()
	defer snapshot.mutex.Unlock()
	if snapshot.closed {
		return nil
	}
	snapshot.closed = true
	return snapshot.handle.Close()
}
