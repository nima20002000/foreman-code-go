//go:build !linux && !darwin

package discovery

func executablePath(string) error {
	return unavailableIdentity()
}

func executableFile(string) error {
	return unavailableIdentity()
}

func readableFile(string) error {
	return unavailableIdentity()
}
