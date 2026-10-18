package files

import (
	"os"
	"syscall"
)

func storagePlatform() error { return nil }

func openNoFollow(path string, flags int, mode os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flags|syscall.O_NOFOLLOW, mode)
}

func ownedDirectory(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

type fileStamp struct {
	device   uint64
	inode    uint64
	size     int64
	modified syscall.Timespec
	changed  syscall.Timespec
}

func stampFile(handle *os.File) (fileStamp, error) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(handle.Fd()), &stat); err != nil {
		return fileStamp{}, err
	}
	return fileStamp{
		device:   uint64(stat.Dev),
		inode:    uint64(stat.Ino),
		size:     stat.Size,
		modified: stat.Mtim,
		changed:  stat.Ctim,
	}, nil
}
