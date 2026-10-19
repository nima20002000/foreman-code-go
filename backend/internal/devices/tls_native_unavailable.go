//go:build !cgo

package devices

func validateDeviceTLSMaterialsNative(certificate, key []byte, advertisedHostname string) error {
	return ErrDeviceTLSProviderUnavailable
}
