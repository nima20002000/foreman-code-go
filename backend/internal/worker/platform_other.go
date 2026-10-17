//go:build !linux

package worker

import "os"

func workerPlatformError() error {
	return failure("worker_platform_unsupported", "Installed workers require Linux.", nil)
}

func ownedByCurrentUser(os.FileInfo) bool { return false }

func workerSocketName(string) (string, error) {
	return "", workerPlatformError()
}
