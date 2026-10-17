package devices_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

func TestIdentityFailuresPreserveDiagnosticsSentinelsAndTransportEnvelopes(t *testing.T) {
	curve := elliptic.P256()
	der, err := x509.MarshalPKIXPublicKey(&ecdsa.PublicKey{
		Curve: curve, X: curve.Params().Gx, Y: curve.Params().Gy,
	})
	if err != nil {
		t.Fatal(err)
	}
	otherAlgorithm := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	_, algorithmErr := devices.PublicKeyFingerprint(otherAlgorithm)
	_, canonicalErr := devices.PublicKeyFingerprint(vectorPrivateKey)
	_, privateErr := devices.ParseIdentityKey("not a private key")
	var identity devices.MainIdentity
	_, corruptErr := identity.Sign([]byte("identity proof"))
	cases := []struct {
		name     string
		failure  error
		sentinel error
		message  string
	}{
		{
			name: "wrong algorithm", failure: algorithmErr, sentinel: devices.ErrEd25519KeyRequired,
			message: "Worker identity requires an Ed25519 key.",
		},
		{
			name: "noncanonical public key", failure: canonicalErr, sentinel: devices.ErrNonCanonicalPublicKey,
			message: "Publish only a canonical Ed25519 public key, never private key material.",
		},
		{
			name: "invalid private key", failure: privateErr, sentinel: devices.ErrInvalidIdentityKey,
			message: "Device identity requires a valid Ed25519 private key.",
		},
		{
			name: "corrupt main identity", failure: corruptErr, sentinel: devices.ErrCorruptMainIdentity,
			message: "Main device-authentication identity is corrupt; explicit recovery is required.",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if test.failure == nil {
				t.Fatal("device API accepted an invalid identity")
			}
			if test.failure != test.sentinel || test.failure.Error() != test.message {
				t.Fatalf("device API failure = %v; want the original sentinel and message %q", test.failure, test.message)
			}
			wrapped := fmt.Errorf("load device identity: %w", test.failure)
			if wrapped.Error() != "load device identity: "+test.message || errors.Unwrap(wrapped) != test.failure {
				t.Fatalf("wrapping changed the diagnostic or cause: %v", wrapped)
			}
			for _, failure := range []struct {
				name string
				err  error
			}{
				{name: "direct", err: test.failure},
				{name: "wrapped", err: wrapped},
			} {
				t.Run(failure.name, func(t *testing.T) {
					for _, other := range cases {
						if got := errors.Is(failure.err, other.sentinel); got != (other.name == test.name) {
							t.Fatalf("errors.Is for %q = %v", other.name, got)
						}
					}
					recorder := httptest.NewRecorder()
					handler := (httpserver.ErrorHandler{}).Wrap(func(http.ResponseWriter, *http.Request) error {
						return failure.err
					})
					handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/device-identity", nil))
					if recorder.Code != http.StatusInternalServerError {
						t.Fatalf("HTTP status = %d", recorder.Code)
					}
					var httpBody map[string]any
					if err := json.Unmarshal(recorder.Body.Bytes(), &httpBody); err != nil {
						t.Fatal(err)
					}
					wantHTTP := map[string]any{"error": map[string]any{
						"code": "INTERNAL_ERROR", "message": "The API could not complete the request.", "requestId": "",
					}}
					if !reflect.DeepEqual(httpBody, wantHTTP) {
						t.Fatalf("HTTP identity failure envelope = %#v", httpBody)
					}
					result := mcpserver.ToolFailure(failure.err)
					if !result.IsError || result.StructuredContent != nil || len(result.Content) != 1 {
						t.Fatalf("Operator identity failure result = %#v", result)
					}
					content, ok := result.Content[0].(*mcp.TextContent)
					if !ok {
						t.Fatalf("Operator identity failure content = %T", result.Content[0])
					}
					var operatorBody map[string]any
					if err := json.Unmarshal([]byte(content.Text), &operatorBody); err != nil {
						t.Fatal(err)
					}
					wantOperator := map[string]any{"error": map[string]any{
						"code": "INTERNAL_ERROR", "message": "The Operator service could not complete the request.",
					}}
					if !reflect.DeepEqual(operatorBody, wantOperator) {
						t.Fatalf("Operator identity failure envelope = %#v", operatorBody)
					}
				})
			}
		})
	}
}
