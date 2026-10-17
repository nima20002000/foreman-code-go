//go:build linux

package roots

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

const directoryFlags = os.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW

var mountIdentityPattern = regexp.MustCompile(`(?m)^mnt_id:\s*(\d+)$`)

func openDirectory(path string, flags int) (*Directory, error) {
	file, err := os.OpenFile(path, flags, 0)
	if err != nil {
		return nil, err
	}
	return &Directory{file: file}, nil
}

func pinnedPath(file *os.File, name string) string {
	path := fmt.Sprintf("/proc/self/fd/%d", file.Fd())
	if name != "" {
		path += "/" + name
	}
	return path
}

// nativeIdentity is native descriptor metadata, not a workspace-root wire DTO.
// The caller holds the Directory lock for the complete observation.
func nativeIdentity(file *os.File) (syscall.Stat_t, string, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		return stat, "", err
	}
	info, err := os.ReadFile(fmt.Sprintf("/proc/self/fdinfo/%d", file.Fd()))
	if err != nil {
		return stat, "", err
	}
	mount := mountIdentityPattern.FindSubmatch(info)
	if len(mount) != 2 {
		return stat, "", unsupportedFilesystem("Linux mount identity cannot be qualified.")
	}
	return stat, string(mount[1]), nil
}

func (directory *Directory) nativeIdentity() (syscall.Stat_t, string, error) {
	directory.mu.RLock()
	defer directory.mu.RUnlock()
	if directory.file == nil {
		return syscall.Stat_t{}, "", os.ErrClosed
	}
	return nativeIdentity(directory.file)
}

// SameDirectory compares the pinned device, inode and mount identities.
func (directory *Directory) SameDirectory(other *Directory) (bool, error) {
	left, leftMount, err := directory.nativeIdentity()
	if err != nil {
		return false, err
	}
	right, rightMount, err := other.nativeIdentity()
	if err != nil {
		return false, err
	}
	return left.Dev == right.Dev && left.Ino == right.Ino && leftMount == rightMount, nil
}

func (directory *Directory) reopen() (*Directory, error) {
	directory.mu.RLock()
	defer directory.mu.RUnlock()
	if directory.file == nil {
		return nil, os.ErrClosed
	}
	// This follows the kernel descriptor link, not a caller-controlled symlink.
	return openDirectory(pinnedPath(directory.file, ""), directoryFlags&^syscall.O_NOFOLLOW)
}

func privateDirectoryMode(stat syscall.Stat_t, privateOnly bool) bool {
	if privateOnly {
		return stat.Mode&0o077 == 0 && stat.Mode&0o700 == 0o700
	}
	return stat.Mode&0o022 == 0 && stat.Mode&0o500 == 0o500
}

// OpenPrivateRoot qualifies a canonical Linux root component by component.
// privateOnly requires mode 0700; otherwise a worker-owned protected base is
// accepted. It never changes ownership or permissions to qualify a directory.
func OpenPrivateRoot(path string, privateOnly bool) (*Directory, error) {
	if !filepath.IsAbs(path) {
		return nil, unsupportedFilesystem("An approved canonical Linux private root is required.")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if canonical != path {
		return nil, unsupportedFilesystem("An approved canonical Linux private root is required.")
	}
	parent, err := openDirectory("/", directoryFlags)
	if err != nil {
		return nil, err
	}
	owned := true
	defer func() {
		if owned {
			_ = parent.Close()
		}
	}()
	for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if component == "" {
			continue
		}
		child, err := openRootComponent(parent, component)
		if err != nil {
			return nil, err
		}
		if err := parent.Close(); err != nil {
			_ = child.Close()
			return nil, err
		}
		parent = child
	}
	stat, _, err := parent.nativeIdentity()
	if err != nil {
		return nil, err
	}
	if stat.Uid != uint32(os.Getuid()) || !privateDirectoryMode(stat, privateOnly) {
		message := "The approved base must be worker-owned and protected from other writers."
		if privateOnly {
			message = "The approved root must be owned by this worker with mode 0700."
		}
		return nil, sourceError("SOURCE_ROOT_NOT_PRIVATE", message)
	}
	current, err := openDirectory(path, directoryFlags)
	if err != nil {
		return nil, err
	}
	defer current.Close()
	matching, err := parent.SameDirectory(current)
	if err != nil {
		return nil, err
	}
	if !matching {
		return nil, sourceError("SOURCE_ROOT_CHANGED", "Root changed during validation.")
	}
	owned = false
	return parent, nil
}

func openRootComponent(parent *Directory, component string) (*Directory, error) {
	parent.mu.RLock()
	defer parent.mu.RUnlock()
	if parent.file == nil {
		return nil, os.ErrClosed
	}
	ancestor, _, err := nativeIdentity(parent.file)
	if err != nil {
		return nil, err
	}
	if (ancestor.Uid != 0 && ancestor.Uid != uint32(os.Getuid())) ||
		(ancestor.Mode&0o022 != 0 && ancestor.Mode&0o1000 == 0) {
		return nil, unsupportedFilesystem("Root ancestors must exclude replacement by other principals.")
	}
	child, err := openDirectory(pinnedPath(parent.file, component), directoryFlags)
	if err != nil {
		return nil, err
	}
	if ancestor.Mode&0o022 != 0 {
		stat, _, err := child.nativeIdentity()
		if err != nil {
			_ = child.Close()
			return nil, err
		}
		if stat.Uid != uint32(os.Getuid()) {
			_ = child.Close()
			return nil, unsupportedFilesystem("Sticky-directory entries must be owned by this worker.")
		}
	}
	return child, nil
}

// OpenChild opens a single private child on the pinned parent's filesystem and
// mount. Creation, when requested, uses 0700 and never repairs an existing entry.
func (directory *Directory) OpenChild(name string, create bool) (*Directory, error) {
	if _, err := RelativePath(name); err != nil {
		return nil, err
	}
	if name == "" || strings.Contains(name, "/") {
		return nil, invalidRelativePath()
	}
	directory.mu.RLock()
	defer directory.mu.RUnlock()
	if directory.file == nil {
		return nil, os.ErrClosed
	}
	path := pinnedPath(directory.file, name)
	if create {
		if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	child, err := openDirectory(path, directoryFlags)
	if err != nil {
		return nil, err
	}
	stat, childMount, err := child.nativeIdentity()
	if err != nil {
		_ = child.Close()
		return nil, err
	}
	if stat.Uid != uint32(os.Getuid()) || stat.Mode&0o077 != 0 {
		_ = child.Close()
		return nil, sourceError("SOURCE_DIRECTORY_NOT_PRIVATE", "Materialization parents must be private worker directories.")
	}
	parentStat, parentMount, err := nativeIdentity(directory.file)
	if err != nil {
		_ = child.Close()
		return nil, err
	}
	if parentStat.Dev != stat.Dev || parentMount != childMount {
		_ = child.Close()
		return nil, sourceError("SOURCE_MOUNT_CHANGED", "Source entries cannot cross a filesystem or mount boundary.")
	}
	return child, nil
}
