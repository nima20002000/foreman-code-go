package handoffs_test

import (
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
		wantError bool
	}{
		{name: "omitted with one received request", received: []string{requestA}, want: requestA},
		{name: "explicit matching request", requested: &requestA, received: []string{requestA}, want: requestA},
		{name: "explicit choice among received requests", requested: &requestB, received: []string{requestA, requestB}, want: requestB},
		{name: "omitted without received work", wantError: true},
		{name: "omitted with several received requests", received: []string{requestA, requestB}, wantError: true},
		{name: "unreceived request", requested: &foreign, received: []string{requestA, requestB}, wantError: true},
		{name: "explicit without received work", requested: &requestA, wantError: true},
		{name: "duplicate received IDs remain ambiguous", received: []string{requestA, requestA}, wantError: true},
		{name: "explicit duplicate received ID", requested: &requestA, received: []string{requestA, requestA}, want: requestA},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := handoffs.ResolveReturnRequestID(tc.requested, tc.received)
			if (err != nil) != tc.wantError {
				t.Fatalf("ResolveReturnRequestID() error = %v, wantError %v", err, tc.wantError)
			}
			if got != tc.want {
				t.Fatalf("ResolveReturnRequestID() = %q, want %q", got, tc.want)
			}
		})
	}
}
