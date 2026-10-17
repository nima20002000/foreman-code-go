package handoffs

import (
	"context"
	"errors"
)

// ActivationReader supplies the private ancestry projection for one exact Run.
// Implementations must read from one consistent snapshot, scope every lookup by
// runID, and return an error when a required record is absent. They return stored
// fields unchanged; this interface supplies no acceptance or admission proof.
type ActivationReader interface {
	ReadActivation(ctx context.Context, runID, activationID string) (nodeID, causeKind, causeID, lineageID string, err error)
}

// ParentReader reads the exact request, return, denial, and notice links used by
// work_parent_request. ReadDenialContinuation must select the notice by the same
// Run and its limit_denial cause ID; another notice is not evidence of this link.
// All record reads have ActivationReader's snapshot and missing-record rules.
type ParentReader interface {
	ActivationReader
	ReadRequestDestination(ctx context.Context, runID, requestID string) (activationID, nodeID string, err error)
	ReadReturnRequester(ctx context.Context, runID, returnID string) (requesterID, continuationID string, err error)
	ReadDenialRequester(ctx context.Context, runID, denialID string) (requesterID string, err error)
	ReadDenialContinuation(ctx context.Context, runID, denialID string) (continuationID string, err error)
}

// ParentRequestID follows only same-node return/denial continuations back to a
// received request. It is the read-only traversal from work_parent_request.
// An empty ID means the ancestry has no single parent request. Result acceptance
// must separately check the persisted request, source execution, and digest.
func ParentRequestID(ctx context.Context, reader ParentReader, runID, activationID string) (string, error) {
	visited := make(map[string]struct{})
	var originalNode string
	first := true
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if _, exists := visited[activationID]; exists {
			return "", errors.New("WORK_PARENT_REQUEST_CYCLE")
		}
		visited[activationID] = struct{}{}
		nodeID, cause, causeID, _, err := reader.ReadActivation(ctx, runID, activationID)
		if err != nil {
			return "", err
		}
		if first {
			originalNode, first = nodeID, false
		} else if nodeID != originalNode {
			return "", errors.New("WORK_PARENT_REQUEST_NODE_CONFLICT")
		}
		switch cause {
		case "work_request":
			destinationID, destinationNode, err := reader.ReadRequestDestination(ctx, runID, causeID)
			if err != nil {
				return "", err
			}
			if destinationID != activationID || destinationNode != originalNode {
				return "", errors.New("WORK_PARENT_REQUEST_CONFLICT")
			}
			return causeID, nil
		case "work_return":
			requesterID, continuationID, err := reader.ReadReturnRequester(ctx, runID, causeID)
			if err != nil {
				return "", err
			}
			if continuationID != activationID {
				return "", errors.New("WORK_PARENT_REQUEST_CONFLICT")
			}
			activationID = requesterID
		case "limit_denial":
			requesterID, err := reader.ReadDenialRequester(ctx, runID, causeID)
			if err != nil {
				return "", err
			}
			continuationID, err := reader.ReadDenialContinuation(ctx, runID, causeID)
			if err != nil {
				return "", err
			}
			if continuationID != activationID {
				return "", errors.New("WORK_PARENT_REQUEST_CONFLICT")
			}
			activationID = requesterID
		default:
			return "", nil
		}
	}
}

// RoundReader supplies the private joins and request direction used by
// work_round_id. ReadRequestOrigin must select the request in the same Run.
// ReadJoinRequesters returns only requests addressed to that exact activation.
// A missing saved edge is represented by found=false, matching the SQL EXISTS.
// Required record reads otherwise have ActivationReader's snapshot rules.
type RoundReader interface {
	ActivationReader
	ReadRequestOrigin(ctx context.Context, runID, requestID string) (requesterID, destinationID, relationshipID string, err error)
	ReadSavedEdgeSource(ctx context.Context, runID, relationshipID string) (nodeID string, found bool, err error)
	ReadJoinRequesters(ctx context.Context, runID, activationID string) ([]string, error)
}

// RoundID returns the work round, not the root lineage. A review return, limit
// denial, or reverse request begins a new round; forward requests inherit their
// requester's round. Every branch of a join must resolve to the same round.
func RoundID(ctx context.Context, reader RoundReader, runID, activationID string) (string, error) {
	return readRoundID(ctx, reader, runID, activationID, make(map[string]struct{}))
}

func readRoundID(ctx context.Context, reader RoundReader, runID, activationID string, visited map[string]struct{}) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if _, exists := visited[activationID]; exists {
		return "", errors.New("WORK_ROUND_CYCLE")
	}
	visited[activationID] = struct{}{}
	defer delete(visited, activationID)
	nodeID, cause, causeID, lineageID, err := reader.ReadActivation(ctx, runID, activationID)
	if err != nil {
		return "", err
	}
	switch cause {
	case "entry", "dependency":
		return lineageID, nil
	case "work_return", "limit_denial":
		return activationID, nil
	case "work_request":
		requesterID, destinationID, relationshipID, err := reader.ReadRequestOrigin(ctx, runID, causeID)
		if err != nil {
			return "", err
		}
		if destinationID != activationID {
			return "", errors.New("WORK_JOIN_ROUND_CONFLICT")
		}
		sourceNode, found, err := reader.ReadSavedEdgeSource(ctx, runID, relationshipID)
		if err != nil {
			return "", err
		}
		if found && sourceNode == nodeID {
			return activationID, nil
		}
		return readRoundID(ctx, reader, runID, requesterID, visited)
	case "join":
		requesters, err := reader.ReadJoinRequesters(ctx, runID, activationID)
		if err != nil {
			return "", err
		}
		if len(requesters) == 0 {
			return "", errors.New("WORK_JOIN_ROUND_CONFLICT")
		}
		var roundID string
		for index, requesterID := range requesters {
			candidate, err := readRoundID(ctx, reader, runID, requesterID, visited)
			if err != nil {
				return "", err
			}
			if index > 0 && candidate != roundID {
				return "", errors.New("WORK_JOIN_ROUND_CONFLICT")
			}
			roundID = candidate
		}
		return roundID, nil
	default:
		return "", errors.New("WORK_ROUND_CAUSE_UNSUPPORTED")
	}
}
