//go:build !linux

package files

import (
	"errors"
	"os"
)

// Other operating systems still need an equivalent no-follow and descriptor
// change-identity adapter before storage can be enabled there. Never replace
// those checks with a permissive filesystem fallback.
var errStoragePlatform = errors.New("managed file storage is not implemented on this platform")

func storagePlatform() error { return errStoragePlatform }

func openNoFollow(string, int, os.FileMode) (*os.File, error) {
	return nil, errStoragePlatform
}

func ownedDirectory(os.FileInfo) bool { return false }

type fileStamp struct{}

func stampFile(*os.File) (fileStamp, error) { return fileStamp{}, errStoragePlatform }
