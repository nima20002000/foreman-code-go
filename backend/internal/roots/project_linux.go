//go:build linux

package roots

import (
	"errors"
	"os"
	"strings"
	"syscall"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// OpenProject opens an existing project below this pinned directory. The caller
// owns the returned handle, including for an empty path; this handle stays open.
// Until a private directory is reached, every child must exclude other writers.
// Every child must belong to this worker and stay on its parent's device and mount.
func (directory *Directory) OpenProject(path string) (_ *Directory, err error) {
	if _, err := RelativePath(path); err != nil {
		return nil, err
	}
	parent, err := directory.reopen()
	if err != nil {
		return nil, err
	}
	defer func() {
		if parent != nil {
			if closeErr := parent.Close(); closeErr != nil {
				err = closeErr
			}
		}
	}()
	info, err := parent.Stat()
	if err != nil {
		return nil, err
	}
	privatePrefix := info.Mode().Perm()&0o077 == 0
	if path != "" {
		for _, component := range strings.Split(path, "/") {
			child, nextPrivate, err := parent.openProjectChild(component, privatePrefix)
			if err != nil {
				return nil, err
			}
			privatePrefix = nextPrivate
			closeErr := parent.Close()
			// The parent was closed even when Close reports an error. Transfer
			// cleanup ownership now so a failed close cannot leak the child.
			parent = child
			if closeErr != nil {
				return nil, closeErr
			}
		}
	}
	result := parent
	parent = nil
	return result, nil
}

func (directory *Directory) openProjectChild(name string, privatePrefix bool) (_ *Directory, _ bool, err error) {
	directory.mu.RLock()
	defer directory.mu.RUnlock()
	if directory.file == nil {
		return nil, false, os.ErrClosed
	}
	child, err := openDirectory(pinnedPath(directory.file, name), directoryFlags)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR) {
			missing := domainerror.New("ROOT_DIRECTORY_MISSING", "The selected folder does not exist on this computer.", 400, nil)
			missing.Cause = err
			return nil, false, missing
		}
		return nil, false, err
	}
	retained := false
	defer func() {
		if !retained {
			if closeErr := child.Close(); closeErr != nil {
				err = closeErr
			}
		}
	}()
	info, err := child.Stat()
	if err != nil {
		return nil, false, err
	}
	parentStat, parentMount, err := nativeIdentity(directory.file)
	if err != nil {
		return nil, false, err
	}
	childStat, childMount, err := child.nativeIdentity()
	if err != nil {
		return nil, false, err
	}
	stat := info.Sys().(*syscall.Stat_t)
	if stat.Uid != uint32(os.Getuid()) || (!privatePrefix && stat.Mode&0o022 != 0) ||
		parentStat.Dev != childStat.Dev || parentMount != childMount {
		return nil, false, sourceError("ROOT_FILESYSTEM_UNSUPPORTED", "Selected folders must be worker-owned and protected from other writers on the approved filesystem.")
	}
	if !privatePrefix {
		info, err = child.Stat()
		if err != nil {
			return nil, false, err
		}
		privatePrefix = info.Mode().Perm()&0o077 == 0
	}
	retained = true
	return child, privatePrefix, nil
}
