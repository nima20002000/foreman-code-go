package discovery

import (
	"os"
	"syscall"
)

func nativeFingerprintIdentity(info os.FileInfo) (fingerprintIdentity, error) {
	value, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fingerprintIdentity{}, unavailableIdentity()
	}
	return fingerprintIdentity{
		Device: uint64(value.Dev), Inode: uint64(value.Ino), Size: info.Size(),
		ModifiedSeconds: int64(value.Mtim.Sec), ModifiedNanoseconds: int64(value.Mtim.Nsec),
		ChangedSeconds: int64(value.Ctim.Sec), ChangedNanoseconds: int64(value.Ctim.Nsec),
	}, nil
}
