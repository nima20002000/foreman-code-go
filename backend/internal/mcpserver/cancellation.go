package mcpserver

import (
	"context"
	"encoding/json"
	"math"
	"sync"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// rpcID follows the frozen JavaScript Map key boundary. The type tag keeps a
// number distinct from a string; text is the shared opaque UTF-16 unit identity.
// Principal keys and request keys are separate map dimensions, never joined.
type rpcID struct {
	text     string
	number   int64
	isString bool
}

func requestID(value any) (rpcID, bool) {
	switch value := value.(type) {
	case jsonvalue.UTF16String:
		return rpcID{text: value.IdentityKey(), isString: true}, true
	case json.Number:
		number, err := jsonvalue.NumberFloat64(value)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) ||
			math.Trunc(number) != number || math.Abs(number) > 9_007_199_254_740_991 {
			return rpcID{}, false
		}
		// Conversion occurs after JavaScript binary64 rounding and safe-integer
		// validation. It intentionally makes -0, 0.0 and 0e0 the same key.
		return rpcID{number: int64(number)}, true
	default:
		return rpcID{}, false
	}
}

type cancellationRegistry struct {
	mu      sync.Mutex
	callers map[string]map[rpcID]*cancellableOperation
}

type cancellableOperation struct {
	ctx       context.Context
	cancel    context.CancelFunc
	registry  *cancellationRegistry
	principal string
	id        rpcID
	finished  bool // protected by registry.mu
}

func (registry *cancellationRegistry) track(ctx context.Context, principal string, id rpcID) (*cancellableOperation, error) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	requests := registry.callers[principal]
	if _, present := requests[id]; present {
		return nil, domainerror.New("MCP_REQUEST_IN_FLIGHT", "This MCP request id is already in flight.", 409, nil)
	}
	if registry.callers == nil {
		registry.callers = make(map[string]map[rpcID]*cancellableOperation)
	}
	if requests == nil {
		requests = make(map[rpcID]*cancellableOperation)
		registry.callers[principal] = requests
	}
	operationContext, cancel := context.WithCancel(ctx)
	operation := &cancellableOperation{ctx: operationContext, cancel: cancel,
		registry: registry, principal: principal, id: id}
	requests[id] = operation
	return operation, nil
}

func (registry *cancellationRegistry) cancel(principal string, id rpcID) {
	registry.mu.Lock()
	operation := registry.callers[principal][id]
	registry.mu.Unlock()
	if operation != nil {
		// Cancellation does not release the in-flight ID. Only response finish
		// or transport disconnect does so, matching the source tracker.
		operation.cancel()
	}
}

func (operation *cancellableOperation) finish() {
	registry := operation.registry
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if operation.finished {
		return
	}
	operation.finished = true
	requests := registry.callers[operation.principal]
	if requests[operation.id] != operation {
		return
	}
	delete(requests, operation.id)
	if len(requests) == 0 {
		delete(registry.callers, operation.principal)
	}
}

func objectField(value jsonvalue.Object, name string) (any, bool) {
	for _, member := range value {
		if textEquals(member.Key, name) {
			return member.Value, true
		}
	}
	return nil, false
}

// All protocol field names used here are ASCII. Comparison is over exact units
// and cannot turn an unpaired surrogate into a matching replacement character.
func textEquals(value any, expected string) bool {
	units, ok := value.(jsonvalue.UTF16String)
	if !ok || len(units) != len(expected) {
		return false
	}
	for index, unit := range units {
		if unit != uint16(expected[index]) {
			return false
		}
	}
	return true
}
