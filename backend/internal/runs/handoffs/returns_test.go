package handoffs_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/handoffs"
)

func TestResolveReturnRequestID(t *testing.T) {
	requestA, requestB, foreign := "request-a", "request-b", "foreign-request"
	cases := []struct {
		name      string
		requested *string
		received  []string
		want      string
		wantError string
	}{
		{name: "omitted with one received request", received: []string{requestA}, want: requestA},
		{name: "explicit matching request", requested: &requestA, received: []string{requestA}, want: requestA},
		{name: "explicit choice among received requests", requested: &requestB, received: []string{requestA, requestB}, want: requestB},
		{name: "omitted without received work", wantError: "Return requestId may be omitted only when exactly one received request is open."},
		{name: "omitted with several received requests", received: []string{requestA, requestB}, wantError: "Return requestId may be omitted only when exactly one received request is open."},
		{name: "unreceived request", requested: &foreign, received: []string{requestA, requestB}, wantError: "Return requestId must match an open received request."},
		{name: "explicit without received work", requested: &requestA, wantError: "Return requestId must match an open received request."},
		{name: "duplicate received IDs remain ambiguous", received: []string{requestA, requestA}, wantError: "Return requestId may be omitted only when exactly one received request is open."},
		{name: "explicit duplicate received ID", requested: &requestA, received: []string{requestA, requestA}, want: requestA},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := handoffs.ResolveReturnRequestID(tc.requested, tc.received)
			if tc.wantError == "" {
				if err != nil {
					t.Fatalf("ResolveReturnRequestID() error = %v, want no error", err)
				}
			} else {
				if err == nil || err.Error() != tc.wantError {
					t.Fatalf("ResolveReturnRequestID() error = %v, want %q", err, tc.wantError)
				}
				_, repeated := handoffs.ResolveReturnRequestID(tc.requested, tc.received)
				if repeated == nil || repeated.Error() != tc.wantError || errors.Is(err, repeated) {
					t.Fatalf("independent validation failures shared identity or changed reason: %v", repeated)
				}
				wrapped := fmt.Errorf("return result rejected: %w", err)
				if !errors.Is(wrapped, err) || errors.Unwrap(err) != nil {
					t.Fatal("validation error changed its identity or acquired a cause")
				}
			}
			if got != tc.want {
				t.Fatalf("ResolveReturnRequestID() = %q, want %q", got, tc.want)
			}
		})
	}
}
