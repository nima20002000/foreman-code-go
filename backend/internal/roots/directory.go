package roots

import (
	"os"
	"strings"
	"sync"
)

// Directory owns a pinned native directory descriptor. It is deliberately
// opaque: generated workspace-root contract identities belong to the shared
// contracts export and are not reproduced by this filesystem primitive.
type Directory struct {
	mu   sync.RWMutex
	file *os.File
}

// Close releases this handle without closing any independently opened child.
func (directory *Directory) Close() error {
	directory.mu.Lock()
	defer directory.mu.Unlock()
	if directory.file == nil {
		return os.ErrClosed
	}
	file := directory.file
	directory.file = nil
	return file.Close()
}

// Stat observes the pinned directory, even if its original pathname moved.
func (directory *Directory) Stat() (os.FileInfo, error) {
	directory.mu.RLock()
	defer directory.mu.RUnlock()
	if directory.file == nil {
		return nil, os.ErrClosed
	}
	return directory.file.Stat()
}

// EntryParent opens only the directory components of a validated relative path.
// The caller owns the returned handle; the root handle remains open.
func (directory *Directory) EntryParent(path string, create bool) (*Directory, string, error) {
	if _, err := RelativePath(path); err != nil {
		return nil, "", err
	}
	if path == "" {
		return nil, "", invalidRelativePath()
	}
	components := strings.Split(path, "/")
	leaf := components[len(components)-1]
	parent := directory
	for _, component := range components[:len(components)-1] {
		child, err := parent.OpenChild(component, create)
		if parent != directory {
			closeErr := parent.Close()
			if err == nil && closeErr != nil {
				if child != nil {
					_ = child.Close()
				}
				return nil, "", closeErr
			}
		}
		if err != nil {
			return nil, "", err
		}
		parent = child
	}
	if parent == directory {
		var err error
		parent, err = directory.reopen()
		if err != nil {
			return nil, "", err
		}
	}
	return parent, leaf, nil
}
