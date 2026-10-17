//go:build linux || darwin

package discovery

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func executablePath(path string) error {
	return unix.Access(path, unix.X_OK)
}

func executableFile(path string) error {
	if err := executablePath(path); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("Not a file")
	}
	return nil
}

func readableFile(path string) error {
	return unix.Access(path, unix.R_OK)
}
