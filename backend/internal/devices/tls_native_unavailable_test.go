//go:build !cgo

package devices_test

import (
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

func TestDeviceTLSMaterialsReportUnavailableWithoutCGO(t *testing.T) {
	err := devices.ValidateDeviceTLSMaterials([]byte("disposable certificate bytes"), []byte("disposable key bytes"), "main.example.com")
	if err != devices.ErrDeviceTLSProviderUnavailable {
		t.Fatalf("unsupported native provider result = %v", err)
	}
}
