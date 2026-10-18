//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package devices

import "os"

// The frozen ownership comparison cannot succeed without a POSIX current UID.
// Do not substitute a permissive no-follow or owner check on other platforms.
func openDeviceTLSFile(string) (DeviceTLSFile, error) {
	return nil, ErrDeviceTLSFilePermissions
}

func deviceTLSFileOwned(os.FileInfo) bool { return false }
