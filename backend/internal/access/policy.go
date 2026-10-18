// Package access ports the shared principal and scope policy. Domain lanes own
// credential persistence, live Worker bindings and resource-specific authority.
package access

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/contracts"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// Resource is an in-process authorization argument, never a wire DTO. Every
// identifier uses the generated contract's lossless Text/ID representation.
type Resource struct {
	WorkspaceID               contracts.Optional[contracts.ID]
	WorkflowID                contracts.Optional[contracts.ID]
	RunID                     contracts.Optional[contracts.ID]
	MainID                    contracts.Optional[contracts.Text]
	DeviceID                  contracts.Optional[contracts.Text]
	ApplicationInstallationID contracts.Optional[contracts.Text]
	ProviderAccountID         contracts.Optional[contracts.Text]
}

// Principal owns an immutable, generated-schema-normalized snapshot. Its zero
// value is unauthenticated. Values returned by Generated are detached copies.
type Principal struct {
	value      contracts.ManagementPrincipal
	expiresMS  int64
	validated  bool
}

// Policy requires the generated registry. A nil clock selects time.Now; callers
// may provide an isolated clock without changing global time or process state.
type Policy struct {
	registry *contracts.Registry
	now      func() time.Time
}

func NewPolicy(registry *contracts.Registry, now func() time.Time) (*Policy, error) {
	if registry == nil {
		return nil, fmt.Errorf("access policy requires the generated contract registry")
	}
	if now == nil {
		now = time.Now
	}
	return &Policy{registry: registry, now: now}, nil
}

// ParsePrincipal uses generated contract parsing, including source defaults,
// normalization and Worker subject refinement. No public shape is copied here.
func (p *Policy) ParsePrincipal(raw json.RawMessage) (Principal, error) {
	if p == nil || p.registry == nil {
		return Principal{}, fmt.Errorf("access policy requires the generated contract registry")
	}
	parsed, err := contracts.ParseManagementPrincipal(p.registry, raw)
	if err != nil {
		return Principal{}, err
	}
	expires, err := timestampMillis(parsed.ExpiresAt)
	if err != nil {
		return Principal{}, err
	}
	return Principal{value: clonePrincipal(parsed), expiresMS: expires, validated: true}, nil
}

// Snapshot re-parses mutable generated values just as authorizationPrincipal
// does in TS. Only this package's private immutable snapshots bypass re-parsing.
func (p *Policy) Snapshot(value contracts.ManagementPrincipal) (Principal, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return Principal{}, err
	}
	return p.ParsePrincipal(raw)
}

func (p Principal) Generated() contracts.ManagementPrincipal { return clonePrincipal(p.value) }

// IdentityKey is an opaque injective UTF16-unit key, never display text or a token.
// An unvalidated zero Principal returns an empty key and cannot authorize a call.
func (p Principal) IdentityKey() string {
	if !p.validated {
		return ""
	}
	return p.value.ID.IdentityKey()
}

func (p *Policy) IsAuthorized(principal Principal, action contracts.ManagementAction, resource Resource) bool {
	if !p.active(principal) || principal.value.Audience != contracts.ManagementPrincipalAudienceOperator {
		return false
	}
	for _, grant := range principal.value.Grants {
		if hasAction(grant, action) && matchesScope(grant.Scope, resource) {
			return true
		}
	}
	return false
}

// HasAction ignores resource dimensions for catalog visibility only. Request
// execution must use IsAuthorized/Require with its actual resource identifiers.
func (p *Policy) HasAction(principal Principal, action contracts.ManagementAction) bool {
	if !p.active(principal) || principal.value.Audience != contracts.ManagementPrincipalAudienceOperator {
		return false
	}
	for _, grant := range principal.value.Grants {
		if hasAction(grant, action) {
			return true
		}
	}
	return false
}

func (p *Policy) Require(principal Principal, action contracts.ManagementAction, resource Resource) error {
	if !p.IsAuthorized(principal, action, resource) {
		return domainerror.New("ACCESS_DENIED", "The caller is not authorized for this operation and resource.", 403, nil)
	}
	return nil
}

func (p *Policy) active(principal Principal) bool {
	return p != nil && p.now != nil && principal.activeAt(p.now())
}

func (p Principal) activeAt(now time.Time) bool {
	_, revoked := p.value.RevokedAt.Get()
	return p.validated && !revoked && p.expiresMS > now.UnixMilli()
}

// The generated Timestamp schema has already enforced the pinned Zod calendar,
// required seconds and colon-offset grammar. RFC3339Nano accepts arbitrary
// fraction length; UnixMilli then matches Date.parse's millisecond truncation.
func timestampMillis(value contracts.Text) (int64, error) {
	text, err := value.UTF8()
	if err != nil {
		return 0, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return 0, fmt.Errorf("parse generated access timestamp: %w", err)
	}
	return parsed.UnixMilli(), nil
}
