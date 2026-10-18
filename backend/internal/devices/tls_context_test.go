package devices_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/mldsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

func newDeviceTLSContextFixture(t *testing.T, customize func(*x509.Certificate, *x509.Certificate)) deviceTLSFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{
		SerialNumber:       big.NewInt(7),
		Subject:            pkix.Name{CommonName: "material example"},
		NotBefore:          time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:           time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
		SignatureAlgorithm: x509.ECDSAWithSHA1,
	}
	issuer := &x509.Certificate{Subject: leaf.Subject}
	if customize != nil {
		customize(leaf, issuer)
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, issuer, key.Public(), key)
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

func TestDeviceTLSMaterialsPreserveLoadSignatureMetadata(t *testing.T) {
	cases := []struct {
		name      string
		customize func(*x509.Certificate, *x509.Certificate)
		accepted  bool
	}{
		{name: "self-issued SHA1 without key identifiers", accepted: true},
		{name: "nonself-issued SHA1", customize: func(leaf, issuer *x509.Certificate) {
			issuer.Subject.CommonName = "different issuer"
		}},
		{name: "canonical ASCII case and whitespace", accepted: true, customize: func(leaf, issuer *x509.Certificate) {
			leaf.Subject.CommonName = "  MATERIAL   Example  "
			issuer.Subject.CommonName = "material example"
		}},
		{name: "Unicode case is preserved", customize: func(leaf, issuer *x509.Certificate) {
			leaf.Subject.CommonName = "Éxample"
			issuer.Subject.CommonName = "éxample"
		}},
		{name: "same canonical string across supported ASN1 types", accepted: true, customize: func(leaf, issuer *x509.Certificate) {
			leaf.RawSubject = deviceTLSNameFixture(t, asn1.TagUTF8String, []byte("example"))
			issuer.RawSubject = deviceTLSNameFixture(t, asn1.TagPrintableString, []byte("EXAMPLE"))
		}},
		{name: "NumericString preserves its ASN1 type", customize: func(leaf, issuer *x509.Certificate) {
			leaf.RawSubject = deviceTLSNameFixture(t, asn1.TagNumericString, []byte("123"))
			issuer.RawSubject = deviceTLSNameFixture(t, asn1.TagPrintableString, []byte("123"))
		}},
		{name: "strong signature with different issuer", accepted: true, customize: func(leaf, issuer *x509.Certificate) {
			leaf.SignatureAlgorithm = x509.ECDSAWithSHA256
			issuer.Subject.CommonName = "different issuer"
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSContextFixture(t, test.customize)
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "")
			if test.accepted {
				if err != nil {
					t.Fatalf("frozen context-load metadata rejected: %v", err)
				}
			} else if !errors.Is(err, devices.ErrDeviceTLSWeakCertificateSignature) {
				t.Fatalf("weak nonself-signed metadata error = %v", err)
			}
		})
	}
}

func deviceTLSNameFixture(t *testing.T, tag int, value []byte) []byte {
	t.Helper()
	name, err := asn1.Marshal(pkix.RDNSequence{{{
		Type:  asn1.ObjectIdentifier{2, 5, 4, 3},
		Value: asn1.RawValue{Tag: tag, Bytes: value},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return name
}

func TestDeviceTLSMaterialsPreserveAuthorityIdentifierPresence(t *testing.T) {
	cases := []struct {
		name       string
		subject    []byte
		authority  []byte
		subjectSet bool
		keyIDSet   bool
		accepted   bool
	}{
		{name: "matching identifiers", subject: []byte{1}, authority: []byte{1}, subjectSet: true, keyIDSet: true, accepted: true},
		{name: "different identifiers", subject: []byte{1}, authority: []byte{2}, subjectSet: true, keyIDSet: true},
		{name: "present empty authority identifier", subject: []byte{1}, subjectSet: true, keyIDSet: true},
		{name: "present empty subject identifier", authority: []byte{1}, subjectSet: true, keyIDSet: true},
		{name: "both identifiers present empty", subjectSet: true, keyIDSet: true, accepted: true},
		{name: "authority identifier absent", subject: []byte{1}, subjectSet: true, accepted: true},
		{name: "subject identifier absent", authority: []byte{1}, keyIDSet: true, accepted: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSContextFixture(t, func(leaf, issuer *x509.Certificate) {
				if test.subjectSet {
					value, err := asn1.Marshal(test.subject)
					if err != nil {
						t.Fatal(err)
					}
					leaf.ExtraExtensions = append(leaf.ExtraExtensions, pkix.Extension{Id: asn1.ObjectIdentifier{2, 5, 29, 14}, Value: value})
				}
				var fields []byte
				if test.keyIDSet {
					value, err := asn1.Marshal(asn1.RawValue{Class: 2, Tag: 0, Bytes: test.authority})
					if err != nil {
						t.Fatal(err)
					}
					fields = value
				}
				value, err := asn1.Marshal(asn1.RawValue{Tag: asn1.TagSequence, IsCompound: true, Bytes: fields})
				if err != nil {
					t.Fatal(err)
				}
				leaf.ExtraExtensions = append(leaf.ExtraExtensions, pkix.Extension{Id: asn1.ObjectIdentifier{2, 5, 29, 35}, Value: value})
			})
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "")
			if test.accepted {
				if err != nil {
					t.Fatalf("optional identifier rejected: %v", err)
				}
			} else if !errors.Is(err, devices.ErrDeviceTLSWeakCertificateSignature) {
				t.Fatalf("authority identifier mismatch error = %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsDoNotVerifySelfSignatureAtLoad(t *testing.T) {
	fixture := newDeviceTLSContextFixture(t, nil)
	modified := append([]byte{}, fixture.der...)
	modified[len(modified)-1] ^= 1
	material := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: modified})
	err := devices.ValidateDeviceTLSMaterials(material, fixture.key, "")
	if err != nil {
		t.Fatalf("metadata-only material load verified the certificate signature: %v", err)
	}
}

func TestDeviceTLSMaterialsPreserveAuthoritySerialAndIssuerMetadata(t *testing.T) {
	matchingName := deviceTLSNameFixture(t, asn1.TagUTF8String, []byte("material example"))
	otherName := deviceTLSNameFixture(t, asn1.TagUTF8String, []byte("different issuer"))
	directoryName := func(name []byte) asn1.RawValue {
		return asn1.RawValue{Class: 2, Tag: 4, IsCompound: true, Bytes: name}
	}
	cases := []struct {
		name     string
		serial   *big.Int
		issuers  []asn1.RawValue
		accepted bool
	}{
		{name: "matching serial", serial: big.NewInt(7), accepted: true},
		{name: "different serial", serial: big.NewInt(8)},
		{name: "matching first directory name", issuers: []asn1.RawValue{directoryName(matchingName), directoryName(otherName)}, accepted: true},
		{name: "different first directory name", issuers: []asn1.RawValue{directoryName(otherName), directoryName(matchingName)}},
		{name: "no directory name", issuers: []asn1.RawValue{{Class: 2, Tag: 2, Bytes: []byte("irrelevant.example.com")}}, accepted: true},
		{name: "directory name after another general name", issuers: []asn1.RawValue{{Class: 2, Tag: 2, Bytes: []byte("irrelevant.example.com")}, directoryName(matchingName)}, accepted: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeviceTLSContextFixture(t, func(leaf, issuer *x509.Certificate) {
				var names []byte
				for _, name := range test.issuers {
					encoded, err := asn1.Marshal(name)
					if err != nil {
						t.Fatal(err)
					}
					names = append(names, encoded...)
				}
				authority := struct {
					Issuer asn1.RawValue `asn1:"optional,tag:1"`
					Serial *big.Int      `asn1:"optional,tag:2"`
				}{Serial: test.serial}
				if test.issuers != nil {
					authority.Issuer = asn1.RawValue{Class: 2, Tag: 1, IsCompound: true, Bytes: names}
				}
				encoded, err := asn1.Marshal(authority)
				if err != nil {
					t.Fatal(err)
				}
				leaf.ExtraExtensions = append(leaf.ExtraExtensions, pkix.Extension{Id: asn1.ObjectIdentifier{2, 5, 29, 35}, Value: encoded})
			})
			err := devices.ValidateDeviceTLSMaterials(fixture.certificate, fixture.key, "")
			if test.accepted {
				if err != nil {
					t.Fatalf("accepted authority metadata rejected: %v", err)
				}
			} else if !errors.Is(err, devices.ErrDeviceTLSWeakCertificateSignature) {
				t.Fatalf("authority metadata mismatch error = %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsCheckChainLoadStrengthBeforePrivateKey(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	weak := newDeviceTLSContextFixture(t, func(leaf, issuer *x509.Certificate) {
		issuer.Subject.CommonName = "different issuer"
	})
	material := append(append([]byte{}, fixture.certificate...), weak.certificate...)
	err := devices.ValidateDeviceTLSMaterials(material, []byte("bad key"), "wrong.example.com")
	if !errors.Is(err, devices.ErrDeviceTLSWeakCertificateSignature) {
		t.Fatalf("chain load did not precede key and host checks: %v", err)
	}
}

func TestDeviceTLSMaterialsPreserveNativeMLDSAParameters(t *testing.T) {
	for _, parameters := range []mldsa.Parameters{mldsa.MLDSA44(), mldsa.MLDSA65(), mldsa.MLDSA87()} {
		t.Run(parameters.String(), func(t *testing.T) {
			key, err := mldsa.GenerateKey(parameters)
			if err != nil {
				t.Fatal(err)
			}
			leaf := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "mldsa fixture"}, NotBefore: time.Unix(1, 0), NotAfter: time.Unix(2, 0)}
			der, err := x509.CreateCertificate(rand.Reader, leaf, leaf, key.PublicKey(), key)
			if err != nil {
				t.Fatal(err)
			}
			privateDER, err := x509.MarshalPKCS8PrivateKey(key)
			if err != nil {
				t.Fatal(err)
			}
			err := devices.ValidateDeviceTLSMaterials(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}), "")
			if err != nil {
				t.Fatalf("native ML-DSA material rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsAcceptNativeRSAKeySizes(t *testing.T) {
	for _, bits := range []int{1024, 2048} {
		name := "RSA-1024"
		if bits == 2048 {
			name = "RSA-2048"
		}
		t.Run(name, func(t *testing.T) {
			key, err := rsa.GenerateKey(rand.Reader, bits)
			if err != nil {
				t.Fatal(err)
			}
			leaf := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "rsa fixture"}, NotBefore: time.Unix(1, 0), NotAfter: time.Unix(2, 0)}
			der, err := x509.CreateCertificate(rand.Reader, leaf, leaf, key.Public(), key)
			if err != nil {
				t.Fatal(err)
			}
			err := devices.ValidateDeviceTLSMaterials(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), "")
			if err != nil {
				t.Fatalf("accepted frozen RSA key size rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSMaterialsRejectWeakLeafAndChainPublicKeys(t *testing.T) {
	signer, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// Only a disposable certificate public value is constructed here. The weak
	// key must be rejected before the deliberately malformed private material.
	weakPublic := &rsa.PublicKey{N: new(big.Int).Add(new(big.Int).Lsh(big.NewInt(1), 511), big.NewInt(1)), E: 65537}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "weak fixture"}, NotBefore: time.Unix(1, 0), NotAfter: time.Unix(2, 0)}
	der, err := x509.CreateCertificate(rand.Reader, leaf, leaf, weakPublic, signer)
	if err != nil {
		t.Fatal(err)
	}
	weak := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	strong := newDeviceTLSFixture(t, nil)
	cases := []struct {
		name        string
		certificate []byte
		want        error
	}{
		{name: "leaf", certificate: weak, want: devices.ErrDeviceTLSLeafKeyTooSmall},
		{name: "chain", certificate: append(append([]byte{}, strong.certificate...), weak...), want: devices.ErrDeviceTLSChainKeyTooSmall},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := devices.ValidateDeviceTLSMaterials(test.certificate, []byte("bad key"), "wrong.example.com")
			if !errors.Is(err, test.want) {
				t.Fatalf("weak key load error = %v; want %v", err, test.want)
			}
		})
	}
}

func TestDeviceTLSMaterialsPreserveIndependentCertificateAndKeySlots(t *testing.T) {
	ec := newDeviceTLSFixture(t, nil)
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "rsa fixture"}, NotBefore: time.Unix(1, 0), NotAfter: time.Unix(2, 0)}
	rsaDER, err := x509.CreateCertificate(rand.Reader, leaf, leaf, rsaKey.Public(), rsaKey)
	if err != nil {
		t.Fatal(err)
	}
	rsaCertificate := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rsaDER})
	rsaPrivate := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)})
	cases := []struct {
		name        string
		certificate []byte
		key         []byte
		hostname    string
		want        error
	}{
		{name: "EC certificate with RSA key and matching host", certificate: ec.certificate, key: rsaPrivate, hostname: "main.example.com"},
		{name: "RSA certificate with EC key", certificate: rsaCertificate, key: ec.key},
		{name: "EC host identity retained after RSA key", certificate: ec.certificate, key: rsaPrivate, hostname: "wrong.example.com", want: devices.ErrDeviceTLSHostMismatch},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := devices.ValidateDeviceTLSMaterials(test.certificate, test.key, test.hostname); !errors.Is(err, test.want) {
				t.Fatalf("independent algorithm-slot material result = %v; want %v", err, test.want)
			}
		})
	}
}
