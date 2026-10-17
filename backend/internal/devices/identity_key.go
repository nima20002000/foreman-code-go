// Package devices owns the authenticated connection between Main and workers.
package devices

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"strings"
	"unicode"
)

var (
	ErrEd25519KeyRequired    = errors.New("Worker identity requires an Ed25519 key.")
	ErrNonCanonicalPublicKey = errors.New("Publish only a canonical Ed25519 public key, never private key material.")
	ErrInvalidIdentityKey    = errors.New("Device identity requires a valid Ed25519 private key.")
)

// IdentityKey holds cryptographic state, not a shared protocol or domain DTO.
// Use generated contract types when constructing pairing and proof messages.
type IdentityKey struct {
	private     ed25519.PrivateKey
	publicPEM   string
	fingerprint string
}

// PublicKeyFingerprint matches the frozen device-identity-node SPKI fingerprint.
// Private keys, multiple PEM blocks, and alternative public encodings cannot be
// published even when they describe an otherwise valid Ed25519 key.
func PublicKeyFingerprint(publicKey string) (string, error) {
	key, der, err := canonicalPublicKey(publicKey)
	if err != nil {
		return "", err
	}
	if len(key) != ed25519.PublicKeySize {
		return "", ErrEd25519KeyRequired
	}
	digest := sha256.Sum256(der)
	return hex.EncodeToString(digest[:]), nil
}

func canonicalPublicKey(value string) (ed25519.PublicKey, []byte, error) {
	trimmed := trimKeyPEM(value)
	block, rest := pem.Decode([]byte(trimmed))
	if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(rest) != 0 {
		return nil, nil, ErrNonCanonicalPublicKey
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, nil, ErrNonCanonicalPublicKey
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, nil, ErrEd25519KeyRequired
	}
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, nil, ErrNonCanonicalPublicKey
	}
	canonical := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	if trimmed != trimKeyPEM(canonical) {
		return nil, nil, ErrNonCanonicalPublicKey
	}
	return key, der, nil
}

// ECMAScript trim includes the BOM and excludes U+0085. Internal whitespace is
// retained so the byte-for-byte canonical-public-key check stays strict.
func trimKeyPEM(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r == '\ufeff' || r != '\u0085' && unicode.IsSpace(r)
	})
}

// GenerateIdentityKey creates a fresh Ed25519 key using the operating system's
// cryptographic random source. Persistence is owned by the caller.
func GenerateIdentityKey() (*IdentityKey, error) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return identityKey(private)
}

// ParseIdentityKey restores the PKCS8 private key written by the TS identity
// helper. It never substitutes a new identity for missing or corrupt material.
func ParseIdentityKey(privateKey string) (*IdentityKey, error) {
	block, rest := pem.Decode([]byte(trimKeyPEM(privateKey)))
	if block == nil || block.Type != "PRIVATE KEY" || len(block.Headers) != 0 || len(rest) != 0 {
		return nil, ErrInvalidIdentityKey
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, ErrInvalidIdentityKey
	}
	private, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, ErrEd25519KeyRequired
	}
	return identityKey(private)
}

func identityKey(private ed25519.PrivateKey) (*IdentityKey, error) {
	if len(private) != ed25519.PrivateKeySize {
		return nil, ErrInvalidIdentityKey
	}
	der, err := x509.MarshalPKIXPublicKey(private.Public())
	if err != nil {
		return nil, ErrInvalidIdentityKey
	}
	publicPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	digest := sha256.Sum256(der)
	return &IdentityKey{
		private:     append(ed25519.PrivateKey(nil), private...),
		publicPEM:   publicPEM,
		fingerprint: hex.EncodeToString(digest[:]),
	}, nil
}

func (key *IdentityKey) PublicKey() string {
	return key.publicPEM
}

func (key *IdentityKey) Fingerprint() string {
	return key.fingerprint
}

// PrivateKeyPEM is intended only for private identity storage. Protocol messages
// must use PublicKey; no private key is needed by the peer.
func (key *IdentityKey) PrivateKeyPEM() (string, error) {
	if key == nil || len(key.private) != ed25519.PrivateKeySize {
		return "", ErrInvalidIdentityKey
	}
	der, err := x509.MarshalPKCS8PrivateKey(key.private)
	if err != nil {
		return "", ErrInvalidIdentityKey
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}

// Sign signs the exact bytes supplied by the generated-contract proof adapter.
func (key *IdentityKey) Sign(message []byte) ([]byte, error) {
	if key == nil || len(key.private) != ed25519.PrivateKeySize {
		return nil, ErrInvalidIdentityKey
	}
	return ed25519.Sign(key.private, message), nil
}

// VerifyIdentitySignature requires the same canonical public key that is safe
// to publish. A malformed key or signature is an ordinary failed verification.
func VerifyIdentitySignature(publicKey string, message, signature []byte) bool {
	key, _, err := canonicalPublicKey(publicKey)
	return err == nil && ed25519.Verify(key, message, signature)
}
