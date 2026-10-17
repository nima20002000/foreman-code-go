package worker

import (
	"os"
	"path/filepath"
)

// RequirePrivateDirectory returns the canonical directory only when its final
// entry is a real directory owned by this user with no group or other access.
// An existing directory's mode is never repaired or widened implicitly.
func RequirePrivateDirectory(directory string) (string, error) {
	if err := workerPlatformError(); err != nil {
		return "", err
	}
	if !filepath.IsAbs(directory) {
		return "", failure("private_directory_required", "", nil)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 || !ownedByCurrentUser(info) {
		return "", failure("private_directory_required", "", nil)
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	return canonical, nil
}

// PrepareStateDirectory creates only the explicitly selected private state
// directory. Identity, pairing and native journals require their owning services.
func PrepareStateDirectory(directory string) (string, error) {
	if err := workerPlatformError(); err != nil {
		return "", err
	}
	if !filepath.IsAbs(directory) {
		return "", failure("private_directory_required", "", nil)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	return RequirePrivateDirectory(directory)
}
