package handoffs_test

import (
	"context"
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/runs/handoffs"
)

func parentFixture() *readerFixture {
	r := newReaderFixture()
	r.activations[rowKey("run", "received")] = [4]string{"reviewer", "work_request", "request", "lineage"}
	r.activations[rowKey("run", "returned")] = [4]string{"reviewer", "work_return", "return", "lineage"}
	r.activations[rowKey("run", "denied")] = [4]string{"reviewer", "limit_denial", "denial", "lineage"}
	r.destinations[rowKey("run", "request")] = [2]string{"received", "reviewer"}
	r.returns[rowKey("run", "return")] = [2]string{"received", "returned"}
	r.denials[rowKey("run", "denial")] = "returned"
	r.notices[rowKey("run", "denial")] = "denied"
	return r
}

func TestParentRequestIDFollowsContinuationAncestry(t *testing.T) {
	for _, activationID := range []string{"received", "returned", "denied"} {
		t.Run(activationID, func(t *testing.T) {
			id, err := handoffs.ParentRequestID(context.Background(), parentFixture(), "run", activationID)
			if err != nil || id != "request" {
				t.Fatalf("ParentRequestID() = %q, %v; want request", id, err)
			}
		})
	}
}

func TestParentRequestIDWithoutSingleParent(t *testing.T) {
	for _, cause := range []string{"entry", "dependency", "join"} {
		t.Run(cause, func(t *testing.T) {
			r := newReaderFixture()
			r.activations[rowKey("run", "activation")] = [4]string{"node", cause, "cause", "lineage"}
			id, err := handoffs.ParentRequestID(context.Background(), r, "run", "activation")
			if err != nil || id != "" {
				t.Fatalf("ParentRequestID() = %q, %v; want no single parent", id, err)
			}
		})
	}
}

func TestParentRequestIDRejectsConflictingAncestry(t *testing.T) {
	cases := []struct {
		name   string
		change func(*readerFixture)
		want   string
	}{
		{name: "request addressed to another activation", change: func(r *readerFixture) {
			r.destinations[rowKey("run", "request")] = [2]string{"other", "reviewer"}
		}, want: "WORK_PARENT_REQUEST_CONFLICT"},
		{name: "request addressed to another node", change: func(r *readerFixture) {
			r.destinations[rowKey("run", "request")] = [2]string{"received", "other-node"}
		}, want: "WORK_PARENT_REQUEST_CONFLICT"},
		{name: "return belongs to another continuation", change: func(r *readerFixture) {
			r.returns[rowKey("run", "return")] = [2]string{"received", "other"}
		}, want: "WORK_PARENT_REQUEST_CONFLICT"},
		{name: "denial notice belongs to another continuation", change: func(r *readerFixture) {
			r.notices[rowKey("run", "denial")] = "other"
		}, want: "WORK_PARENT_REQUEST_CONFLICT"},
		{name: "continuation crosses nodes", change: func(r *readerFixture) {
			r.activations[rowKey("run", "returned")] = [4]string{"other-node", "work_return", "return", "lineage"}
		}, want: "WORK_PARENT_REQUEST_NODE_CONFLICT"},
		{name: "continuation cycle", change: func(r *readerFixture) {
			r.returns[rowKey("run", "return")] = [2]string{"denied", "returned"}
		}, want: "WORK_PARENT_REQUEST_CYCLE"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := parentFixture()
			tc.change(r)
			id, err := handoffs.ParentRequestID(context.Background(), r, "run", "denied")
			if id != "" || err == nil || err.Error() != tc.want {
				t.Fatalf("ParentRequestID() = %q, %v; want %s", id, err, tc.want)
			}
		})
	}
}

func TestParentRequestIDRequiresLinkedRecords(t *testing.T) {
	cases := []struct {
		name   string
		change func(*readerFixture)
	}{
		{name: "activation", change: func(r *readerFixture) { delete(r.activations, rowKey("run", "received")) }},
		{name: "request", change: func(r *readerFixture) { delete(r.destinations, rowKey("run", "request")) }},
		{name: "return", change: func(r *readerFixture) { delete(r.returns, rowKey("run", "return")) }},
		{name: "denial", change: func(r *readerFixture) { delete(r.denials, rowKey("run", "denial")) }},
		{name: "notice", change: func(r *readerFixture) { delete(r.notices, rowKey("run", "denial")) }},
		{name: "notice only exists in another Run", change: func(r *readerFixture) {
			delete(r.notices, rowKey("run", "denial"))
			r.notices[rowKey("other-run", "denial")] = "denied"
		}},
		{name: "request only exists in another Run", change: func(r *readerFixture) {
			delete(r.destinations, rowKey("run", "request"))
			r.destinations[rowKey("other-run", "request")] = [2]string{"received", "reviewer"}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := parentFixture()
			tc.change(r)
			id, err := handoffs.ParentRequestID(context.Background(), r, "run", "denied")
			if id != "" || !errors.Is(err, errMissingRecord) {
				t.Fatalf("ParentRequestID() = %q, %v; want missing scoped record", id, err)
			}
		})
	}
}

func roundFixture() *readerFixture {
	r := newReaderFixture()
	r.activations[rowKey("run", "entry")] = [4]string{"entry-node", "entry", "run", "lineage"}
	r.activations[rowKey("run", "left")] = [4]string{"left-node", "work_request", "left-request", "lineage"}
	r.activations[rowKey("run", "right")] = [4]string{"right-node", "work_request", "right-request", "lineage"}
	r.activations[rowKey("run", "join")] = [4]string{"join-node", "join", "join", "lineage"}
	r.activations[rowKey("run", "returned")] = [4]string{"entry-node", "work_return", "return", "lineage"}
	r.activations[rowKey("run", "denied")] = [4]string{"entry-node", "limit_denial", "denial", "lineage"}
	r.activations[rowKey("run", "reverse")] = [4]string{"entry-node", "work_request", "reverse-request", "lineage"}
	r.activations[rowKey("run", "dependency")] = [4]string{"entry-node", "dependency", "resolution", "lineage"}
	r.origins[rowKey("run", "left-request")] = [3]string{"entry", "left", "left-edge"}
	r.origins[rowKey("run", "right-request")] = [3]string{"entry", "right", "right-edge"}
	r.origins[rowKey("run", "reverse-request")] = [3]string{"left", "reverse", "left-edge"}
	r.edgeSources[rowKey("run", "left-edge")] = "entry-node"
	r.edgeSources[rowKey("run", "right-edge")] = "entry-node"
	r.joins[rowKey("run", "join")] = []string{"left", "right"}
	return r
}

func TestRoundIDPreservesRoundBoundaries(t *testing.T) {
	cases := []struct {
		activation string
		want       string
	}{
		{"entry", "lineage"},
		{"dependency", "lineage"},
		{"left", "lineage"},
		{"right", "lineage"},
		{"join", "lineage"},
		{"returned", "returned"},
		{"denied", "denied"},
		{"reverse", "reverse"},
	}
	for _, tc := range cases {
		t.Run(tc.activation, func(t *testing.T) {
			id, err := handoffs.RoundID(context.Background(), roundFixture(), "run", tc.activation)
			if err != nil || id != tc.want {
				t.Fatalf("RoundID() = %q, %v; want %q", id, err, tc.want)
			}
		})
	}
}

func TestRoundIDAllowsSharedAncestorsAcrossJoinBranches(t *testing.T) {
	r := roundFixture()
	r.joins[rowKey("run", "join")] = []string{"left", "right", "left"}
	id, err := handoffs.RoundID(context.Background(), r, "run", "join")
	if err != nil || id != "lineage" {
		t.Fatalf("RoundID() = %q, %v; want shared lineage", id, err)
	}
}

func TestRoundIDRejectsConflicts(t *testing.T) {
	cases := []struct {
		name       string
		activation string
		change     func(*readerFixture)
		want       string
	}{
		{name: "join spans distinct rounds", activation: "join", change: func(r *readerFixture) {
			r.joins[rowKey("run", "join")] = []string{"left", "returned"}
		}, want: "WORK_JOIN_ROUND_CONFLICT"},
		{name: "join has no requests", activation: "join", change: func(r *readerFixture) {
			delete(r.joins, rowKey("run", "join"))
		}, want: "WORK_JOIN_ROUND_CONFLICT"},
		{name: "request addresses another activation", activation: "left", change: func(r *readerFixture) {
			r.origins[rowKey("run", "left-request")] = [3]string{"entry", "other", "left-edge"}
		}, want: "WORK_JOIN_ROUND_CONFLICT"},
		{name: "request ancestry cycle", activation: "left", change: func(r *readerFixture) {
			r.origins[rowKey("run", "left-request")] = [3]string{"right", "left", "left-edge"}
			r.origins[rowKey("run", "right-request")] = [3]string{"left", "right", "right-edge"}
		}, want: "WORK_ROUND_CYCLE"},
		{name: "join ancestry cycle", activation: "join", change: func(r *readerFixture) {
			r.joins[rowKey("run", "join")] = []string{"left", "join"}
		}, want: "WORK_ROUND_CYCLE"},
		{name: "unsupported cause", activation: "entry", change: func(r *readerFixture) {
			r.activations[rowKey("run", "entry")] = [4]string{"entry-node", "unknown", "cause", "lineage"}
		}, want: "WORK_ROUND_CAUSE_UNSUPPORTED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := roundFixture()
			tc.change(r)
			id, err := handoffs.RoundID(context.Background(), r, "run", tc.activation)
			if id != "" || err == nil || err.Error() != tc.want {
				t.Fatalf("RoundID() = %q, %v; want %s", id, err, tc.want)
			}
		})
	}
}

func TestRoundIDRequiresScopedRequestAncestry(t *testing.T) {
	r := roundFixture()
	delete(r.origins, rowKey("run", "left-request"))
	r.origins[rowKey("other-run", "left-request")] = [3]string{"entry", "left", "left-edge"}
	id, err := handoffs.RoundID(context.Background(), r, "run", "join")
	if id != "" || !errors.Is(err, errMissingRecord) {
		t.Fatalf("RoundID() = %q, %v; want missing scoped request", id, err)
	}
}

func TestRoundIDMissingSavedEdgeDoesNotCreateReverseRound(t *testing.T) {
	r := roundFixture()
	delete(r.edgeSources, rowKey("run", "left-edge"))
	r.edgeSources[rowKey("other-run", "left-edge")] = "entry-node"
	id, err := handoffs.RoundID(context.Background(), r, "run", "reverse")
	if err != nil || id != "lineage" {
		t.Fatalf("RoundID() = %q, %v; want inherited lineage", id, err)
	}
}

func TestAncestryReadersPropagateReadErrors(t *testing.T) {
	want := errors.New("snapshot unavailable")
	r := newReaderFixture()
	r.failure = want
	for _, resolve := range []struct {
		name string
		call func(context.Context) (string, error)
	}{
		{"parent", func(ctx context.Context) (string, error) { return handoffs.ParentRequestID(ctx, r, "run", "activation") }},
		{"round", func(ctx context.Context) (string, error) { return handoffs.RoundID(ctx, r, "run", "activation") }},
	} {
		t.Run(resolve.name, func(t *testing.T) {
			id, err := resolve.call(context.Background())
			if id != "" || !errors.Is(err, want) {
				t.Fatalf("ancestry resolution = %q, %v; want original read error", id, err)
			}
		})
	}
}

func TestAncestryReadersRespectCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, resolve := range []struct {
		name string
		call func(context.Context) (string, error)
	}{
		{"parent", func(ctx context.Context) (string, error) { return handoffs.ParentRequestID(ctx, parentFixture(), "run", "denied") }},
		{"round", func(ctx context.Context) (string, error) { return handoffs.RoundID(ctx, roundFixture(), "run", "join") }},
	} {
		t.Run(resolve.name, func(t *testing.T) {
			id, err := resolve.call(ctx)
			if id != "" || !errors.Is(err, context.Canceled) {
				t.Fatalf("ancestry resolution = %q, %v; want cancellation", id, err)
			}
		})
	}
}
