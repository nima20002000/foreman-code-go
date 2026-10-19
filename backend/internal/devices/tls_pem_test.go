package devices_test

import (
	"bytes"
	"crypto/rand"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

func TestDeviceTLSMaterialsPreservePEMLabelsAndAuxiliaryParsing(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	other := newDeviceTLSFixture(t, nil)
	auxiliary, err := asn1.Marshal(struct {
		Alias string `asn1:"utf8"`
	}{Alias: "disposable certificate label"})
	if err != nil {
		t.Fatal(err)
	}
	withAuxiliary := append(append([]byte{}, fixture.der...), auxiliary...)
	cases := []struct {
		name        string
		certificate []byte
	}{
		{name: "legacy leaf label", certificate: pem.EncodeToMemory(&pem.Block{Type: "X509 CERTIFICATE", Bytes: fixture.der})},
		{name: "trusted leaf label without AUX", certificate: pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: fixture.der})},
		{name: "trusted leaf with AUX", certificate: pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: withAuxiliary})},
		{name: "ordinary leaf with AUX", certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: withAuxiliary})},
		{name: "leaf ignores bytes after AUX", certificate: pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: append(append([]byte{}, withAuxiliary...), 1, 2, 3)})},
		{name: "legacy chain label", certificate: append(append([]byte{}, fixture.certificate...), pem.EncodeToMemory(&pem.Block{Type: "X509 CERTIFICATE", Bytes: other.der})...)},
		{name: "ordinary chain ignores trailing DER bytes", certificate: append(append([]byte{}, fixture.certificate...), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: append(append([]byte{}, other.der...), 1, 2, 3)})...)},
		{name: "trusted chain block skipped", certificate: append(append([]byte{}, fixture.certificate...), pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: other.der})...)},
		{name: "skipped trusted block needs no X509 parse", certificate: append(append([]byte{}, fixture.certificate...), pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: []byte{1, 2, 3}})...)},
		{name: "skipped block header ignored", certificate: append(pem.EncodeToMemory(&pem.Block{Type: "OTHER", Headers: map[string]string{"Comment": "fixture"}, Bytes: []byte{1, 2, 3}}), fixture.certificate...)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, fixture.key, "main.example.com")
			if err != nil {
				t.Fatalf("accepted frozen PEM encoding rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsPreserveEmptyPasswordCallbacks(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	privateBlock, _ := pem.Decode(fixture.key)
	if privateBlock == nil {
		t.Fatal("fixture private key did not encode PEM")
	}
	emptyCertificate, err := x509.EncryptPEMBlock(rand.Reader, "CERTIFICATE", fixture.der, nil, x509.PEMCipherAES256)
	if err != nil {
		t.Fatal(err)
	}
	emptyKey, err := x509.EncryptPEMBlock(rand.Reader, "PRIVATE KEY", privateBlock.Bytes, nil, x509.PEMCipherAES256)
	if err != nil {
		t.Fatal(err)
	}
	protectedCertificate, err := x509.EncryptPEMBlock(rand.Reader, "CERTIFICATE", fixture.der, []byte("fixture passphrase"), x509.PEMCipherAES256)
	if err != nil {
		t.Fatal(err)
	}
	protectedKey, err := x509.EncryptPEMBlock(rand.Reader, "PRIVATE KEY", privateBlock.Bytes, []byte("fixture passphrase"), x509.PEMCipherAES256)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name        string
		certificate []byte
		key         []byte
		accepted    bool
	}{
		{name: "empty certificate password", certificate: pem.EncodeToMemory(emptyCertificate), key: fixture.key, accepted: true},
		{name: "empty private key password", certificate: fixture.certificate, key: pem.EncodeToMemory(emptyKey), accepted: true},
		{name: "both passwords empty", certificate: pem.EncodeToMemory(emptyCertificate), key: pem.EncodeToMemory(emptyKey), accepted: true},
		{name: "nonempty certificate password", certificate: pem.EncodeToMemory(protectedCertificate), key: fixture.key},
		{name: "nonempty private key password", certificate: fixture.certificate, key: pem.EncodeToMemory(protectedKey)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, test.key, "main.example.com")
			if (err == nil) != test.accepted {
				t.Fatalf("empty native password callback acceptance = %v; want %v: %v", err == nil, test.accepted, err)
			}
		})
	}
}

func TestDeviceTLSMaterialsRejectMalformedPEMAndMatchingHeaders(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	cases := []struct {
		name        string
		certificate []byte
	}{
		{name: "malformed leaf AUX", certificate: pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: append(append([]byte{}, fixture.der...), 1, 2, 3)})},
		{name: "unknown field inside leaf AUX", certificate: pem.EncodeToMemory(&pem.Block{Type: "TRUSTED CERTIFICATE", Bytes: append(append([]byte{}, fixture.der...), 0x30, 3, 1, 1, 0xff)})},
		{name: "leaf plaintext header", certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Headers: map[string]string{"Comment": "fixture"}, Bytes: fixture.der})},
		{name: "chain plaintext header", certificate: append(append([]byte{}, fixture.certificate...), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Headers: map[string]string{"Comment": "fixture"}, Bytes: fixture.der})...)},
		{name: "malformed nonmatching block first", certificate: append([]byte("-----BEGIN OTHER-----\n!invalid!\n-----END OTHER-----\n"), fixture.certificate...)},
		{name: "malformed nonmatching block last", certificate: append(append([]byte{}, fixture.certificate...), []byte("-----BEGIN OTHER-----\n!invalid!\n-----END OTHER-----\n")...)},
		{name: "missing first end before later certificate", certificate: append([]byte("-----BEGIN CERTIFICATE-----\nAAEC\n"), fixture.certificate...)},
		{name: "mismatched end label", certificate: bytes.Replace(fixture.certificate, []byte("-----END CERTIFICATE-----"), []byte("-----END OTHER-----"), 1)},
		{name: "blank line within certificate body", certificate: bytes.Replace(fixture.certificate, []byte{'\n'}, []byte{'\n', '\n'}, 2)},
		{name: "two header separators", certificate: bytes.Replace(fixture.certificate, []byte{'\n'}, []byte{'\n', '\n', '\n'}, 1)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, fixture.key, "")
			if err == nil {
				t.Fatal("malformed PEM or unsupported certificate header accepted")
			}
		})
	}
}

func TestDeviceTLSMaterialsPermitFrozenPEMPreambleAndLineEndings(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	cases := []struct {
		name        string
		certificate []byte
	}{
		{name: "inline header text is ordinary preamble", certificate: append([]byte("text -----BEGIN CERTIFICATE----- text\n"), fixture.certificate...)},
		{name: "UTF8 BOM", certificate: append([]byte{0xef, 0xbb, 0xbf}, fixture.certificate...)},
		{name: "CRLF", certificate: bytes.ReplaceAll(fixture.certificate, []byte{'\n'}, []byte{'\r', '\n'})},
		{name: "trailing line whitespace", certificate: bytes.ReplaceAll(fixture.certificate, []byte{'\n'}, []byte{' ', '\t', '\n'})},
		{name: "one empty header separator", certificate: bytes.Replace(fixture.certificate, []byte{'\n'}, []byte{'\n', '\n'}, 1)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, fixture.key, "")
			if err != nil {
				t.Fatalf("valid certificate text rejected: %v", err)
			}
		})
	}
}
