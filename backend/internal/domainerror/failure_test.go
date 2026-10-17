package domainerror_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

func TestPublicFailureClassRetainsKnownCodesAndExplicitRetryability(t *testing.T) {
	known := domainerror.New("WORKER_VERSION_SKEW", "worker unavailable", 503, nil)
	known.FailureClass = "permanent"
	explicit := domainerror.New("SERVICE_WAITING", "waiting", 503, nil)
	explicit.FailureClass = "transient"
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{name: "known transient code wins", err: known, want: "transient"},
		{name: "explicit transient", err: explicit, want: "transient"},
		{name: "wrapped transient", err: fmt.Errorf("private context: %w", known), want: "transient"},
		{name: "permanent omitted", err: domainerror.New("REVISION_CONFLICT", "changed", 409, nil)},
		{name: "explicit retryable omitted", err: domainerror.New("DATABASE_BUSY", "busy", 503, map[string]any{"retryable": true})},
		{name: "unknown omitted", err: errors.New("unexpected")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := domainerror.PublicFailureClass(test.err); got != test.want {
				t.Fatalf("public class = %q, want %q", got, test.want)
			}
		})
	}
}
