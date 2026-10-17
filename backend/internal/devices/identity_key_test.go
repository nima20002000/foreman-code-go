package devices_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

// RFC 8032 section 7.1, TEST 1, encoded as SPKI/PKCS8 PEM to match the
// frozen Node helper's public interface. These are published test keys.
// https://www.rfc-editor.org/rfc/rfc8032.txt
const vectorPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n"
const vectorPrivateKey = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n"
const vectorFingerprint = "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9"
const vectorSignature = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"

func TestPublicKeyFingerprintMatchesPublishedSPKIVector(t *testing.T) {
	for _, value := range []string{vectorPublicKey, " \t\n" + vectorPublicKey + "\r\n ", "\ufeff\n" + vectorPublicKey + "\u00a0"} {
		got, err := devices.PublicKeyFingerprint(value)
		if err != nil || got != vectorFingerprint {
			t.Fatalf("published SPKI fingerprint = %q, %v", got, err)
		}
	}
}

func TestPublicKeyFingerprintRejectsPrivateAndNoncanonicalEncodings(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{name: "private key", value: vectorPrivateKey},
		{name: "second public key", value: vectorPublicKey + vectorPublicKey},
		{name: "hidden private key", value: vectorPublicKey + vectorPrivateKey},
		{name: "leading text", value: "untrusted key\n" + vectorPublicKey},
		{name: "trailing text", value: vectorPublicKey + "untrusted key"},
		{name: "non-ECMAScript whitespace", value: "\u0085\n" + vectorPublicKey},
		{name: "different wrapping", value: strings.Replace(vectorPublicKey, "11qY", "\n11qY", 1)},
		{name: "internal CRLF", value: strings.ReplaceAll(vectorPublicKey, "\n", "\r\n")},
		{name: "PEM headers", value: strings.Replace(vectorPublicKey, "MCow", "Comment: unexpected\n\nMCow", 1)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := devices.PublicKeyFingerprint(test.value); !errors.Is(err, devices.ErrNonCanonicalPublicKey) {
				t.Fatalf("expected canonical-public-key refusal, got %v", err)
			}
		})
	}
}

func TestIdentityRejectsOtherKeyAlgorithms(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}))
	if _, err := devices.PublicKeyFingerprint(publicPEM); !errors.Is(err, devices.ErrEd25519KeyRequired) {
		t.Fatalf("expected Ed25519 public-key refusal, got %v", err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	privatePEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}))
	if _, err := devices.ParseIdentityKey(privatePEM); !errors.Is(err, devices.ErrEd25519KeyRequired) {
		t.Fatalf("expected Ed25519 private-key refusal, got %v", err)
	}
}

func TestIdentityKeySignsPublishedEd25519Vector(t *testing.T) {
	key, err := devices.ParseIdentityKey(vectorPrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if key.PublicKey() != vectorPublicKey || key.Fingerprint() != vectorFingerprint {
		t.Fatal("restored key differs from the published public identity")
	}
	private, err := key.PrivateKeyPEM()
	if err != nil || private != vectorPrivateKey {
		t.Fatalf("PKCS8 persistence round trip failed: %v", err)
	}
	signature, err := key.Sign(nil)
	if err != nil || hex.EncodeToString(signature) != vectorSignature {
		t.Fatalf("signature differs from the published Ed25519 vector: %v", err)
	}
	if !devices.VerifyIdentitySignature(vectorPublicKey, nil, signature) {
		t.Fatal("published signature failed verification")
	}
}

func TestIdentitySignatureRejectsChangedMessageKeyAndSignature(t *testing.T) {
	signature, err := hex.DecodeString(vectorSignature)
	if err != nil {
		t.Fatal(err)
	}
	other, err := devices.GenerateIdentityKey()
	if err != nil {
		t.Fatal(err)
	}
	if devices.VerifyIdentitySignature(vectorPublicKey, []byte("changed"), signature) {
		t.Fatal("accepted a signature for a different message")
	}
	if devices.VerifyIdentitySignature(other.PublicKey(), nil, signature) {
		t.Fatal("accepted a signature from a different identity")
	}
	if devices.VerifyIdentitySignature(vectorPrivateKey, nil, signature) {
		t.Fatal("accepted private material in a public-key field")
	}
	if devices.VerifyIdentitySignature(vectorPublicKey, nil, signature[:63]) {
		t.Fatal("accepted a truncated signature")
	}
	signature[0] ^= 1
	if devices.VerifyIdentitySignature(vectorPublicKey, nil, signature) {
		t.Fatal("accepted a modified signature")
	}
}

func TestGeneratedIdentitySurvivesPrivateKeyRoundTrip(t *testing.T) {
	key, err := devices.GenerateIdentityKey()
	if err != nil {
		t.Fatal(err)
	}
	private, err := key.PrivateKeyPEM()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := devices.ParseIdentityKey(private)
	if err != nil {
		t.Fatal(err)
	}
	if restored.PublicKey() != key.PublicKey() || restored.Fingerprint() != key.Fingerprint() {
		t.Fatal("private-key persistence changed the selected identity")
	}
	message := []byte("selected main proof bytes")
	before, err := key.Sign(message)
	if err != nil {
		t.Fatal(err)
	}
	after, err := restored.Sign(message)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("restored identity signs differently: %v", err)
	}
}

func TestIdentityKeyRefusesMissingAndCorruptPrivateMaterial(t *testing.T) {
	for _, value := range []string{"", "not a private key", vectorPublicKey, vectorPrivateKey + vectorPrivateKey} {
		if _, err := devices.ParseIdentityKey(value); !errors.Is(err, devices.ErrInvalidIdentityKey) {
			t.Fatalf("expected corrupt-private-key refusal, got %v", err)
		}
	}
	var key devices.IdentityKey
	if _, err := key.Sign(nil); !errors.Is(err, devices.ErrInvalidIdentityKey) {
		t.Fatalf("zero-value identity signed a message: %v", err)
	}
	if _, err := key.PrivateKeyPEM(); !errors.Is(err, devices.ErrInvalidIdentityKey) {
		t.Fatalf("zero-value identity exported a private key: %v", err)
	}
}
