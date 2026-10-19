package devices_test

import (
	"context"
	"encoding/pem"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

// These fixtures run only in terminal CI after that process has proved its
// linked library, headers and CLI are OpenSSL 3.5.7 and its config/store/key-log
// environment is disposable. Missing prerequisites fail; they never skip.
func deviceTLSOpenSSLFixtureCommand(t *testing.T, directory string, arguments ...string) {
	t.Helper()
	executable := os.Getenv("FOREMAN_TLS_OPENSSL")
	if executable == "" || !filepath.IsAbs(executable) {
		t.Fatal("terminal CI must supply its attested absolute FOREMAN_TLS_OPENSSL fixture executable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Dir = directory
	// All inputs and outputs named by callers are files in this disposable
	// directory. No certificate store, listener or installation is exercised.
	if err := command.Run(); err != nil {
		t.Fatalf("disposable OpenSSL %s fixture command failed: %v", arguments[0], err)
	}
}

func deviceTLSProviderFixtureDirectory(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func deviceTLSProviderFixtureRead(t *testing.T, directory, name string) []byte {
	t.Helper()
	material, err := os.ReadFile(filepath.Join(directory, name))
	if err != nil {
		t.Fatal(err)
	}
	return material
}

func deviceTLSProviderFixtureCertificate(t *testing.T, directory, key string) []byte {
	t.Helper()
	deviceTLSOpenSSLFixtureCommand(t, directory, "req", "-new", "-x509", "-key", key,
		"-out", "certificate.pem", "-subj", "/CN=main.example.com",
		"-addext", "subjectAltName=DNS:main.example.com", "-days", "1")
	return deviceTLSProviderFixtureRead(t, directory, "certificate.pem")
}

func TestDeviceTLSMaterialsAcceptNativeProviderKeyForms(t *testing.T) {
	cases := []struct {
		name      string
		arguments []string
	}{
		{name: "Ed448", arguments: []string{"genpkey", "-algorithm", "ED448", "-out", "private.pem"}},
		{name: "secp256k1", arguments: []string{"genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:secp256k1", "-out", "private.pem"}},
		{name: "restricted RSA-PSS", arguments: []string{"genpkey", "-algorithm", "RSA-PSS", "-pkeyopt", "rsa_keygen_bits:2048", "-pkeyopt", "rsa_pss_keygen_md:sha256", "-pkeyopt", "rsa_pss_keygen_mgf1_md:sha256", "-pkeyopt", "rsa_pss_keygen_saltlen:32", "-out", "private.pem"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			directory := deviceTLSProviderFixtureDirectory(t)
			deviceTLSOpenSSLFixtureCommand(t, directory, test.arguments...)
			certificate := deviceTLSProviderFixtureCertificate(t, directory, "private.pem")
			key := deviceTLSProviderFixtureRead(t, directory, "private.pem")
			if err := devices.ValidateDeviceTLSMaterials(certificate, key, "main.example.com"); err != nil {
				t.Fatalf("frozen native provider material rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsAcceptDSAPrivateKeyEncodings(t *testing.T) {
	directory := deviceTLSProviderFixtureDirectory(t)
	deviceTLSOpenSSLFixtureCommand(t, directory, "genpkey", "-genparam", "-algorithm", "DSA",
		"-pkeyopt", "dsa_paramgen_bits:1024", "-pkeyopt", "dsa_paramgen_q_bits:160", "-out", "parameters.pem")
	deviceTLSOpenSSLFixtureCommand(t, directory, "genpkey", "-paramfile", "parameters.pem", "-out", "private.pem")
	certificate := deviceTLSProviderFixtureCertificate(t, directory, "private.pem")
	deviceTLSOpenSSLFixtureCommand(t, directory, "pkey", "-in", "private.pem", "-traditional", "-out", "traditional.pem")
	for _, encoding := range []struct{ name, path string }{{"PKCS8", "private.pem"}, {"traditional DSA", "traditional.pem"}} {
		t.Run(encoding.name, func(t *testing.T) {
			key := deviceTLSProviderFixtureRead(t, directory, encoding.path)
			if err := devices.ValidateDeviceTLSMaterials(certificate, key, "main.example.com"); err != nil {
				t.Fatalf("accepted DSA material rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsAcceptExpandedMLDSAPrivateKeyForms(t *testing.T) {
	directory := deviceTLSProviderFixtureDirectory(t)
	deviceTLSOpenSSLFixtureCommand(t, directory, "genpkey", "-provparam", "ml-dsa.output_formats=seed-priv", "-algorithm", "ML-DSA-44", "-out", "both.pem")
	certificate := deviceTLSProviderFixtureCertificate(t, directory, "both.pem")
	// The documented encoding option affects this disposable generator only.
	// Material validation itself uses the default provider and all its formats.
	deviceTLSOpenSSLFixtureCommand(t, directory, "pkey", "-provparam", "ml-dsa.retain_seed=no", "-in", "both.pem", "-out", "expanded.pem")
	for _, encoding := range []struct{ name, path string }{{"seed and expanded", "both.pem"}, {"expanded only", "expanded.pem"}} {
		t.Run(encoding.name, func(t *testing.T) {
			key := deviceTLSProviderFixtureRead(t, directory, encoding.path)
			if err := devices.ValidateDeviceTLSMaterials(certificate, key, "main.example.com"); err != nil {
				t.Fatalf("accepted ML-DSA private encoding rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsAcceptWeakPrivateKeyInIndependentSlot(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	directory := deviceTLSProviderFixtureDirectory(t)
	deviceTLSOpenSSLFixtureCommand(t, directory, "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:512", "-out", "private.pem")
	key := deviceTLSProviderFixtureRead(t, directory, "private.pem")
	if err := devices.ValidateDeviceTLSMaterials(fixture.certificate, key, "main.example.com"); err != nil {
		t.Fatalf("private-key slot acquired a certificate-strength policy: %v", err)
	}
}

func TestDeviceTLSMaterialsIsolateConcurrentNativeFailures(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	badCertificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1, 2, 3}})
	certificateFailure := devices.ValidateDeviceTLSMaterials(badCertificate, fixture.key, "")
	if certificateFailure == nil || errors.Is(certificateFailure, devices.ErrDeviceTLSProviderUnavailable) {
		t.Fatalf("native certificate error prerequisite = %v", certificateFailure)
	}
	var workers sync.WaitGroup
	failures := make(chan string, 24)
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if err := devices.ValidateDeviceTLSMaterials(badCertificate, fixture.key, ""); err == nil || err.Error() != certificateFailure.Error() {
				failures <- "certificate failure changed between native transactions"
			}
			if err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "main.example.com"); err != nil {
				failures <- "earlier native errors contaminated successful material validation"
			}
			if err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "wrong.example.com"); err != devices.ErrDeviceTLSHostMismatch {
				failures <- "native errors contaminated advertised-host mismatch"
			}
		}()
	}
	workers.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}
