package worker

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"syscall"
)

func workerPlatformError() error { return nil }

func ownedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func workerSocketName(canonical string) (string, error) {
	digest := sha256.Sum256([]byte(canonical))
	// Go maps the leading @ to the Linux abstract socket's leading NUL. Retain
	// the frozen worker's name so status readers agree on canonical state aliases.
	return "@graphql-worker-" + hex.EncodeToString(digest[:]), nil
}
