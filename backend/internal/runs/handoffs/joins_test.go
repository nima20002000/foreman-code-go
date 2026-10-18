package handoffs_test

import (
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/handoffs"
)

func TestJoinReadyRequiresExactSelectedEdges(t *testing.T) {
	cases := []struct {
		name      string
		required  []string
		selected  []string
		ready     bool
		wantError bool
	}{
		{name: "both branches selected", required: []string{"left", "right"}, selected: []string{"left", "right"}, ready: true},
		{name: "request order is immaterial", required: []string{"left", "right"}, selected: []string{"right", "left"}, ready: true},
		{name: "neither branch selected", required: []string{"left", "right"}},
		{name: "left only must wait", required: []string{"left", "right"}, selected: []string{"left"}},
		{name: "right only must wait", required: []string{"left", "right"}, selected: []string{"right"}},
		{name: "resolved disposition leaves one required edge", required: []string{"right"}, selected: []string{"right"}, ready: true},
		{name: "duplicate does not replace missing branch", required: []string{"left", "right"}, selected: []string{"left", "left"}, wantError: true},
		{name: "foreign edge does not replace missing branch", required: []string{"left", "right"}, selected: []string{"left", "foreign"}, wantError: true},
		{name: "foreign edge after complete selection", required: []string{"left", "right"}, selected: []string{"left", "right", "foreign"}, wantError: true},
		{name: "empty join cannot dispatch"},
		{name: "selected edge in empty join conflicts", selected: []string{"left"}, wantError: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ready, err := handoffs.JoinReady(tc.required, tc.selected)
			if (err != nil) != tc.wantError {
				t.Fatalf("JoinReady() error = %v, wantError %v", err, tc.wantError)
			}
			if ready != tc.ready {
				t.Fatalf("JoinReady() = %v, want %v", ready, tc.ready)
			}
			if err != nil && err.Error() != "WORK_JOIN_SOURCE_CONFLICT" {
				t.Fatalf("JoinReady() conflict = %v", err)
			}
		})
	}
}
