package handoffs

import "errors"

// JoinReady applies resolveWorkJoinLocked's set decision. required must be the
// distinct edge IDs derived from the pinned graph and the current work round,
// after accepted decisions, denials, and unresolved-route dispositions. selected
// contains the relationship IDs of requests addressed to this exact activation.
// Neither input is inferred from the graph's unfiltered incoming edges.
//
// A false result with no required edges means the durable caller must complete
// the empty join without dispatching it. Otherwise false means it is waiting.
// A true result is only readiness: the caller still needs its atomic dispatch
// claim, accepted source receipts, and ownership fence before execution.
func JoinReady(required, selected []string) (bool, error) {
	allowed := make(map[string]struct{}, len(required))
	for _, id := range required {
		allowed[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(selected))
	for _, id := range selected {
		if _, ok := allowed[id]; !ok {
			return false, errors.New("WORK_JOIN_SOURCE_CONFLICT")
		}
		if _, ok := seen[id]; ok {
			return false, errors.New("WORK_JOIN_SOURCE_CONFLICT")
		}
		seen[id] = struct{}{}
	}
	return len(selected) == len(required) && len(required) > 0, nil
}
