package devices

import "errors"

var (
	ErrDeviceTLSHostMismatch             = errors.New("The approved device TLS certificate does not match its public endpoint.")
	ErrDeviceTLSProviderUnavailable      = errors.New("Device TLS material validation requires the native OpenSSL provider.")
	ErrDeviceTLSLeafKeyTooSmall          = errors.New("ee key too small")
	ErrDeviceTLSChainKeyTooSmall         = errors.New("ca key too small")
	ErrDeviceTLSWeakCertificateSignature = errors.New("ca md too weak")
)

// DeviceTLSMaterials contains the files read by this core. Validation success
// describes the frozen material-loading behavior; it does not promise that the
// files form a usable Go listener key pair. OpenSSL maintains algorithm slots.
type DeviceTLSMaterials struct {
	Certificate []byte
	Key         []byte
}

// ValidateDeviceTLSMaterials parses the leaf and certificate chain before the
// private key, applies the frozen native context's key-slot checks, and
// optionally matches the advertised host. The supported native target uses
// OpenSSL 3.5.7; its version and disposable process environment are CI
// prerequisites, not runtime certificate policy implemented here.
// advertisedHostname must be the WHATWG URL hostname with IPv6 brackets removed,
// as supplied by the future endpoint adapter; empty means no advertised endpoint.
// This is material validation, not chain trust, validity-time, purpose, public
// trust adaptation, listener configuration, or device authorization.
func ValidateDeviceTLSMaterials(certificate, key []byte, advertisedHostname string) error {
	return validateDeviceTLSMaterialsNative(certificate, key, advertisedHostname)
}
