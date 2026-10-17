package handoffs_test

import (
	"context"
	"errors"
)

var errMissingRecord = errors.New("scoped fixture record is missing")

// Primitive projections model one frozen, Run-scoped read snapshot. They are
// fixture storage only, not substitute domain DTOs or accepted-work receipts.
type readerFixture struct {
	activations  map[string][4]string
	destinations map[string][2]string
	returns      map[string][2]string
	denials      map[string]string
	notices      map[string]string
	origins      map[string][3]string
	edgeSources  map[string]string
	joins        map[string][]string
	failure      error
}

func newReaderFixture() *readerFixture {
	return &readerFixture{
		activations:  make(map[string][4]string),
		destinations: make(map[string][2]string),
		returns:      make(map[string][2]string),
		denials:      make(map[string]string),
		notices:      make(map[string]string),
		origins:      make(map[string][3]string),
		edgeSources:  make(map[string]string),
		joins:        make(map[string][]string),
	}
}

func rowKey(runID, id string) string { return runID + "\x00" + id }

func (r *readerFixture) ReadActivation(_ context.Context, runID, activationID string) (string, string, string, string, error) {
	if r.failure != nil {
		return "", "", "", "", r.failure
	}
	row, ok := r.activations[rowKey(runID, activationID)]
	if !ok {
		return "", "", "", "", errMissingRecord
	}
	return row[0], row[1], row[2], row[3], nil
}

func (r *readerFixture) ReadRequestDestination(_ context.Context, runID, requestID string) (string, string, error) {
	row, ok := r.destinations[rowKey(runID, requestID)]
	if !ok {
		return "", "", errMissingRecord
	}
	return row[0], row[1], nil
}

func (r *readerFixture) ReadReturnRequester(_ context.Context, runID, returnID string) (string, string, error) {
	row, ok := r.returns[rowKey(runID, returnID)]
	if !ok {
		return "", "", errMissingRecord
	}
	return row[0], row[1], nil
}

func (r *readerFixture) ReadDenialRequester(_ context.Context, runID, denialID string) (string, error) {
	row, ok := r.denials[rowKey(runID, denialID)]
	if !ok {
		return "", errMissingRecord
	}
	return row, nil
}

func (r *readerFixture) ReadDenialContinuation(_ context.Context, runID, denialID string) (string, error) {
	row, ok := r.notices[rowKey(runID, denialID)]
	if !ok {
		return "", errMissingRecord
	}
	return row, nil
}

func (r *readerFixture) ReadRequestOrigin(_ context.Context, runID, requestID string) (string, string, string, error) {
	row, ok := r.origins[rowKey(runID, requestID)]
	if !ok {
		return "", "", "", errMissingRecord
	}
	return row[0], row[1], row[2], nil
}

func (r *readerFixture) ReadSavedEdgeSource(_ context.Context, runID, relationshipID string) (string, bool, error) {
	node, found := r.edgeSources[rowKey(runID, relationshipID)]
	return node, found, nil
}

func (r *readerFixture) ReadJoinRequesters(_ context.Context, runID, activationID string) ([]string, error) {
	return r.joins[rowKey(runID, activationID)], nil
}
