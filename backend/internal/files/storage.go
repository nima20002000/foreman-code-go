// Package files owns managed file bytes. Public file records and request shapes
// belong to the shared generated contracts and are not redefined here.
package files

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

const maxSafeInteger int64 = 9_007_199_254_740_991

var storageKeyPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// TypeVerifier is the frozen FileByteStorage.verifyType boundary. The owning
// generated-contract service must bind its parsed revision and byte-class
// policy here. There is no default that admits unvalidated bytes. The reader
// remains owned by storage; validators must use positioned reads and not close it.
type TypeVerifier func(context.Context, io.ReaderAt, int64) error

// UploadCandidate identifies one private upload attempt, never a host path.
// It corresponds to the internal TS FileUploadCandidate, not a public DTO.
type UploadCandidate struct {
	StorageKey string
	AttemptID  string
}

// FileByteStorage owns same-volume private staging and immutable objects.
// Database locks serialize publication/cancellation in the calling service,
// never the slow receive operation. This first port supports Linux only.
type FileByteStorage struct {
	root          string
	maxBytes      int64
	excludedRoots []string
	initializing  sync.Once
	initialError  error
}

func NewFileByteStorage(root string, maxBytes int64, excludedRoots []string) (*FileByteStorage, error) {
	if !filepath.IsAbs(root) || maxBytes < 1 || maxBytes > maxSafeInteger {
		return nil, errors.New("file storage requires an absolute directory and a positive byte limit")
	}
	return &FileByteStorage{
		root:          filepath.Clean(root),
		maxBytes:      maxBytes,
		excludedRoots: append([]string(nil), excludedRoots...),
	}, nil
}

func DefaultFileStorageRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "graphql", "files"), nil
}

func (storage *FileByteStorage) Root() string { return storage.root }

func (storage *FileByteStorage) Initialize() error {
	storage.initializing.Do(func() { storage.initialError = storage.initialize() })
	return storage.initialError
}

func (storage *FileByteStorage) initialize() error {
	if err := storagePlatform(); err != nil {
		return err
	}
	excluded := append([]string{"/tmp", "/var/tmp", os.TempDir()}, storage.excludedRoots...)
	for index, path := range excluded {
		resolved, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		excluded[index] = resolved
		if overlaps(resolved, storage.root) {
			return errors.New("file storage must be separate from temporary, workspace, and harness directories")
		}
	}
	for ancestor := storage.root; ; ancestor = filepath.Dir(ancestor) {
		canonical, err := filepath.EvalSymlinks(ancestor)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if canonical != ancestor {
			return errors.New("file storage must not traverse symbolic links")
		}
		break
	}
	if err := privateDirectory(storage.root); err != nil {
		return err
	}
	canonical, err := filepath.EvalSymlinks(storage.root)
	if err != nil {
		return err
	}
	if canonical != storage.root {
		return errors.New("file storage must not traverse symbolic links")
	}
	for _, path := range excluded {
		canonical, err := filepath.EvalSymlinks(path)
		if errors.Is(err, os.ErrNotExist) {
			canonical = path
		} else if err != nil {
			return err
		}
		if overlaps(canonical, storage.root) {
			return errors.New("file storage overlaps an excluded directory")
		}
	}
	for _, path := range []string{filepath.Join(storage.root, "objects"), filepath.Join(storage.root, "staging")} {
		if err := privateDirectory(path); err != nil {
			return err
		}
	}
	if err := syncDirectory(storage.root); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(storage.root))
}

func overlaps(left, right string) bool { return inside(left, right) || inside(right, left) }

func inside(parent, child string) bool {
	suffix, err := filepath.Rel(parent, child)
	return err == nil && !filepath.IsAbs(suffix) && suffix != ".." && !strings.HasPrefix(suffix, ".."+string(filepath.Separator))
}

func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 || !ownedDirectory(info) {
		return errors.New("file storage directories must be private, owned directories, not symbolic links")
	}
	return nil
}

func syncDirectory(path string) (err error) {
	handle, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, handle.Close()) }()
	return handle.Sync()
}

func openRegular(path string) (*os.File, error) {
	handle, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	info, err := handle.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("managed bytes are not a regular file")
	}
	if err != nil {
		return nil, errors.Join(err, handle.Close())
	}
	return handle, nil
}

func storageKey(value string) (string, error) {
	if !storageKeyPattern.MatchString(value) {
		return "", errors.New("invalid internal storage key")
	}
	return value, nil
}

func (storage *FileByteStorage) staging(key string) (string, error) {
	value, err := storageKey(key)
	return filepath.Join(storage.root, "staging", value), err
}

func (storage *FileByteStorage) object(key string) (string, error) {
	value, err := storageKey(key)
	return filepath.Join(storage.root, "objects", value), err
}

func (storage *FileByteStorage) candidate(candidate UploadCandidate) (string, error) {
	staging, err := storage.staging(candidate.StorageKey)
	if err != nil {
		return "", err
	}
	attempt, err := storageKey(candidate.AttemptID)
	return filepath.Join(staging, attempt+".part"), err
}

func (storage *FileByteStorage) verified(key string) (string, error) {
	staging, err := storage.staging(key)
	return filepath.Join(staging, "verified"), err
}

func (storage *FileByteStorage) checkSize(size int64) error {
	if size < 0 || size > maxSafeInteger || size > storage.maxBytes {
		return fileError("FILE_TOO_LARGE", "The file exceeds the permitted byte limit.", 413, nil)
	}
	return nil
}

func fileError(code, message string, status int, cause error) error {
	err := domainerror.New(code, message, status, nil)
	err.Cause = cause
	return err
}

func requireVerifier(verifyType TypeVerifier) error {
	if verifyType == nil {
		return errors.New("managed file storage requires its file-type validator")
	}
	return nil
}
