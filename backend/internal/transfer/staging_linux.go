package transfer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// SyncPoint names the existing TypeScript staging durability fault boundaries.
type SyncPoint string

const (
	SyncData      SyncPoint = "data-sync"
	SyncDirectory SyncPoint = "directory-sync"
)

// StagingDirectory pins a private Linux directory. It supplies filesystem
// primitives only: callers retain authorization, quotas, journals and ownership.
type StagingDirectory struct {
	mu         sync.Mutex
	directory  *os.File
	beforeSync func(SyncPoint) error
}

// OpenStagingDirectory creates missing private ancestors and rejects symlinks,
// unsafe ownership and writable non-sticky ancestors. beforeSync may be nil.
func OpenStagingDirectory(root string, beforeSync func(SyncPoint) error) (*StagingDirectory, error) {
	directory, err := openPrivateDirectory(root)
	if err != nil {
		return nil, err
	}
	return &StagingDirectory{directory: directory, beforeSync: beforeSync}, nil
}

func openPrivateDirectory(root string) (*os.File, error) {
	if !filepath.IsAbs(root) {
		return nil, &stagingFailure{reason: relativeRootFailure}
	}
	parts := strings.Split(root, string(filepath.Separator))
	for _, part := range parts {
		if part == "." || part == ".." || strings.ContainsRune(part, '\x00') {
			return nil, &stagingFailure{reason: unsafeRootFailure}
		}
	}
	current, err := os.OpenFile("/", os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range parts {
		if part == "" {
			continue
		}
		next, err := openChildDirectory(current, part)
		if err != nil {
			return nil, errors.Join(err, current.Close())
		}
		closeErr := current.Close()
		current = next
		if closeErr != nil {
			return nil, errors.Join(closeErr, current.Close())
		}
	}
	if err := validateDirectory(current, true); err != nil {
		return nil, errors.Join(err, current.Close())
	}
	return current, nil
}

func openChildDirectory(parent *os.File, name string) (*os.File, error) {
	path := anchoredPath(parent, name)
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	next, err := os.OpenFile(path, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	if err := validateDirectory(next, false); err != nil {
		return nil, errors.Join(err, next.Close())
	}
	return next, nil
}

func validateDirectory(directory *os.File, private bool) error {
	stat, err := directory.Stat()
	if err != nil {
		return err
	}
	identity, ok := stat.Sys().(*syscall.Stat_t)
	if !ok || !stat.IsDir() || (stat.Mode().Perm()&0o022 != 0 && stat.Mode()&os.ModeSticky == 0) ||
		(identity.Uid != 0 && identity.Uid != uint32(os.Getuid())) {
		return &stagingFailure{reason: unsafeAncestorFailure}
	}
	if private && (stat.Mode().Perm()&0o077 != 0 || identity.Uid != uint32(os.Getuid())) {
		return &stagingFailure{reason: privateRootFailure}
	}
	return nil
}

func anchoredPath(directory *os.File, name string) string {
	return fmt.Sprintf("/proc/self/fd/%d/%s", directory.Fd(), name)
}

// OpenPart opens or creates a private singly linked regular part without
// truncating it. The caller must already hold the canonical transfer/allocation
// ownership and supply byte/chunk limits validated by the generated contracts.
// name is a local filename stem, not a substitute for contract ID validation.
func (directory *StagingDirectory) OpenPart(name string, byteLimit int64, chunkLimit int) (*StagingPart, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return nil, &stagingFailure{reason: unsafeNameFailure}
	}
	if byteLimit < 0 || chunkLimit <= 0 {
		return nil, &stagingFailure{reason: invalidLimitsFailure}
	}
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.directory == nil {
		return nil, os.ErrClosed
	}
	path := anchoredPath(directory.directory, name+".part")
	flags := os.O_RDWR | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	file, err := os.OpenFile(path, flags|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		file, err = os.OpenFile(path, flags, 0)
	}
	if err != nil {
		return nil, err
	}
	if _, err := regularFile(file); err != nil {
		return nil, errors.Join(err, file.Close())
	}
	return &StagingPart{file: file, byteLimit: byteLimit, chunkLimit: chunkLimit, beforeSync: directory.beforeSync}, nil
}

func regularFile(file *os.File) (os.FileInfo, error) {
	stat, err := file.Stat()
	if err != nil {
		return nil, err
	}
	identity, ok := stat.Sys().(*syscall.Stat_t)
	if !ok || !stat.Mode().IsRegular() || identity.Nlink != 1 || stat.Mode().Perm()&0o077 != 0 ||
		identity.Uid != uint32(os.Getuid()) {
		return nil, &stagingFailure{reason: unsafeFileFailure}
	}
	return stat, nil
}

// Sync persists directory entries. It does not persist any application journal.
func (directory *StagingDirectory) Sync() error {
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.directory == nil {
		return os.ErrClosed
	}
	return syncAt(directory.directory, SyncDirectory, directory.beforeSync)
}

// Close releases the pinned directory without deleting staged bytes.
func (directory *StagingDirectory) Close() error {
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.directory == nil {
		return nil
	}
	err := directory.directory.Close()
	directory.directory = nil
	return err
}

func syncAt(file *os.File, point SyncPoint, beforeSync func(SyncPoint) error) error {
	if beforeSync != nil {
		if err := beforeSync(point); err != nil {
			return err
		}
	}
	return file.Sync()
}
