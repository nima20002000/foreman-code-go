//go:build cgo

package devices

/*
#cgo pkg-config: openssl
#include "tls_native.h"
*/
import "C"

import (
	"errors"
	"net/netip"
	"unsafe"
)

func validateDeviceTLSMaterialsNative(certificate, key []byte, advertisedHostname string) error {
	hostname := []byte(advertisedHostname)
	isIP := C.int(0)
	if _, err := netip.ParseAddr(advertisedHostname); err == nil {
		isIP = 1
	}
	var result C.device_tls_result
	// Go buffers are borrowed only for this single synchronous C call. Native
	// resources and the thread-local error queue are released before it returns.
	C.device_tls_validate(
		(*C.uchar)(unsafe.Pointer(unsafe.SliceData(certificate))), C.size_t(len(certificate)),
		(*C.uchar)(unsafe.Pointer(unsafe.SliceData(key))), C.size_t(len(key)),
		(*C.uchar)(unsafe.Pointer(unsafe.SliceData(hostname))), C.size_t(len(hostname)),
		isIP, &result,
	)
	switch result.status {
	case C.DEVICE_TLS_OK:
		return nil
	case C.DEVICE_TLS_HOST_MISMATCH:
		return ErrDeviceTLSHostMismatch
	case C.DEVICE_TLS_INVALID_HOSTNAME:
		return errors.New("Invalid name")
	case C.DEVICE_TLS_INVALID_IP:
		return errors.New("Invalid IP")
	case C.DEVICE_TLS_HOST_OPERATION_FAILED:
		return errors.New("Operation failed")
	case C.DEVICE_TLS_LEAF_KEY_TOO_SMALL:
		return &deviceTLSNativeError{message: C.GoString(&result.detail[0]), kind: ErrDeviceTLSLeafKeyTooSmall}
	case C.DEVICE_TLS_CHAIN_KEY_TOO_SMALL:
		return &deviceTLSNativeError{message: C.GoString(&result.detail[0]), kind: ErrDeviceTLSChainKeyTooSmall}
	case C.DEVICE_TLS_WEAK_SIGNATURE:
		return &deviceTLSNativeError{message: C.GoString(&result.detail[0]), kind: ErrDeviceTLSWeakCertificateSignature}
	default:
		return errors.New(C.GoString(&result.detail[0]))
	}
}

type deviceTLSNativeError struct {
	message string
	kind    error
}

func (err *deviceTLSNativeError) Error() string {
	return err.message
}

func (err *deviceTLSNativeError) Unwrap() error {
	return err.kind
}
