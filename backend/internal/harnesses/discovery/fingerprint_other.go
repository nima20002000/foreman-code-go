//go:build !linux && !darwin

package discovery

import "os"

// Unsupported hosts do not receive a weaker identity or reusable digest.
func nativeFingerprintIdentity(os.FileInfo) (fingerprintIdentity, error) {
	return fingerprintIdentity{}, unavailableIdentity()
}
