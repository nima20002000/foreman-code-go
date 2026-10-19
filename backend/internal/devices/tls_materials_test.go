package devices_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

type deviceTLSFixture struct {
	certificate []byte
	key         []byte
	der         []byte
}

// All PKI is generated only when the terminal runs these tests. No real key,
// certificate store, installation, listener, or trust configuration is used.
func newDeviceTLSFixture(t *testing.T, customize func(*x509.Certificate)) deviceTLSFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "main.example.com"},
		DNSNames:     []string{"main.example.com"},
		NotBefore:    time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if customize != nil {
		customize(template)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return deviceTLSFixture{
		certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		key:         pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}),
		der:         der,
	}
}

func TestDeviceTLSMaterialsValidateWithoutChangingInputs(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	certificateBefore := bytes.Clone(fixture.certificate)
	keyBefore := bytes.Clone(fixture.key)
	err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "main.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(fixture.certificate, certificateBefore) || !bytes.Equal(fixture.key, keyBefore) {
		t.Fatal("validation modified the supplied material")
	}
}

func TestDeviceTLSMaterialsRejectInvalidOrMismatchedMaterial(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	other := newDeviceTLSFixture(t, nil)
	badDER := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1, 2, 3}})
	cases := []struct {
		name        string
		certificate []byte
		key         []byte
	}{
		{name: "empty certificate", key: fixture.key},
		{name: "malformed certificate text", certificate: []byte("not a certificate"), key: fixture.key},
		{name: "malformed certificate DER", certificate: badDER, key: fixture.key},
		{name: "private key in certificate input", certificate: fixture.key, key: fixture.key},
		{name: "DER-only certificate", certificate: fixture.der, key: fixture.key},
		{name: "empty private key", certificate: fixture.certificate},
		{name: "malformed private key", certificate: fixture.certificate, key: []byte("not a key")},
		{name: "certificate in private key input", certificate: fixture.certificate, key: fixture.certificate},
		{name: "different private key", certificate: fixture.certificate, key: other.key},
		{name: "malformed trailing certificate DER", certificate: append(append([]byte{}, fixture.certificate...), badDER...), key: fixture.key},
		{name: "malformed trailing certificate base64", certificate: append(append([]byte{}, fixture.certificate...), []byte("-----BEGIN CERTIFICATE-----\n!invalid!\n-----END CERTIFICATE-----\n")...), key: fixture.key},
		{name: "unterminated trailing certificate", certificate: append(append([]byte{}, fixture.certificate...), []byte("-----BEGIN CERTIFICATE-----\nAAEC\n")...), key: fixture.key},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, test.key, "")
			if err == nil {
				t.Fatal("invalid TLS material was accepted")
			}
			if errors.Is(err, devices.ErrDeviceTLSHostMismatch) {
				t.Fatal("material failure was replaced by a hostname failure")
			}
		})
	}
}

func TestDeviceTLSMaterialsPreserveCertificateKeyAndHostErrorOrder(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	badCertificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1, 2, 3}})
	certificateFailure := devices.ValidateDeviceTLSMaterials(badCertificate, fixture.key, "")
	keyFailure := devices.ValidateDeviceTLSMaterials(fixture.certificate, []byte("bad key"), "")
	badChain := append(append([]byte{}, fixture.certificate...), badCertificate...)
	chainFailure := devices.ValidateDeviceTLSMaterials(badChain, fixture.key, "")
	cases := []struct {
		name        string
		certificate []byte
		key         []byte
		want        error
	}{
		{name: "certificate before key", certificate: badCertificate, key: []byte("bad key"), want: certificateFailure},
		{name: "key before host", certificate: fixture.certificate, key: []byte("bad key"), want: keyFailure},
		{name: "chain before key", certificate: badChain, key: []byte("bad key"), want: chainFailure},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, test.key, "wrong.example.com")
			if err == nil || test.want == nil || err.Error() != test.want.Error() {
				t.Fatalf("material validation failure = %v; want earlier failure %v", err, test.want)
			}
		})
	}
}

func TestDeviceTLSMaterialsDoNotAddTrustTimeOrPurposePolicy(t *testing.T) {
	cases := []struct {
		name      string
		customize func(*x509.Certificate)
	}{
		{name: "expired self-signed", customize: func(certificate *x509.Certificate) {
			certificate.NotBefore = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
			certificate.NotAfter = time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
		}},
		{name: "not yet valid", customize: func(certificate *x509.Certificate) {
			certificate.NotBefore = time.Date(2200, 1, 1, 0, 0, 0, 0, time.UTC)
			certificate.NotAfter = time.Date(2201, 1, 1, 0, 0, 0, 0, time.UTC)
		}},
		{name: "client purpose", customize: func(certificate *x509.Certificate) {
			certificate.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		}},
		{name: "omitted advertised host", customize: func(certificate *x509.Certificate) {
			certificate.DNSNames = nil
			certificate.Subject = pkix.Name{}
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSFixture(t, test.customize)
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "")
			if err != nil {
				t.Fatalf("material-only validation added certificate policy: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsAcceptChainAndNonCertificateText(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	other := newDeviceTLSFixture(t, nil)
	material := append([]byte("material preamble\n"), fixture.certificate...)
	material = append(material, other.certificate...)
	material = append(material, []byte("material trailer\n")...)
	err := devices.ValidateDeviceTLSMaterials(material, fixture.key, "main.example.com")
	if err != nil {
		t.Fatal(err)
	}
}
