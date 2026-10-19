//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package devices

import (
	"os"
	"syscall"
)

func openDeviceTLSFile(path string) (DeviceTLSFile, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

func deviceTLSFileOwned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}
