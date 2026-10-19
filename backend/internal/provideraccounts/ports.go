// Package provideraccounts reads finite native authentication status results.
// Production account observations and generated domain contracts stay with the
// owning adapters; this package does not launch processes or change credentials.
package provideraccounts

import (
	"context"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// Provider identifies the qualified native status command.
type Provider string

const (
	Codex  Provider = "codex"
	Claude Provider = "claude"
)

// State is a native subscription observation, not a saved API-key account state.
type State string

const (
	SignedIn    State = "signed-in"
	SignedOut   State = "signed-out"
	Unavailable State = "unavailable"
)

// Status carries only a sanitized native identity and an adapter-validated
// subject. A nil Identity or Subject means that no such value was observed.
// SubjectValue must be the owning adapter's real validated subject type.
type Status[SubjectValue any] struct {
	State    State
	Identity jsonvalue.UTF16String
	Subject  *SubjectValue
}

// CommandResult is the finite output captured by the owning process adapter.
// Code preserves a missing exit code separately from zero. Stdout is decoded
// text, including any stderr that the native launcher combines with stdout.
// The adapter owns byte normalization, the frozen 32,768 UTF-16 capture bound,
// timeout enforcement, executable identity and environment isolation.
type CommandResult struct {
	Code     *int
	Stdout   string
	TimedOut bool
}

// Command transfers one reserved native command's ownership to ReadStatus.
// Run dispatches the prepared command and returns only a finite result. Close
// must confirm physical process exit and release its owner, even when Run was
// never called or failed. It is independent of caller cancellation. Both
// functions are required. A cleanup failure replaces any inspection failure.
type Command struct {
	Run   func(context.Context) (*CommandResult, error)
	Close func() error
}

// Selection is a view of one immutable, fully validated native installation.
// Select and IsCurrent must validate the real complete snapshot, including
// binding, generation, profile, executable, isolation, qualification and support
// flags. IsCurrent reselects and compares that full snapshot, not just the fields
// exposed here. Provider is Codex or Claude. SubjectField is empty or the actual
// qualified subject, accountId or userId field; QualificationID is qualified.
//
// Prepare reserves ownership for the supplied arguments and timeout but does
// not dispatch the native process. If it fails, it cleans all partially acquired
// resources itself. Only a successful return transfers a Command to ReadStatus.
// IsCurrent and Prepare are required; they and their immutable snapshot must
// remain valid through Close and the final IsCurrent call.
type Selection struct {
	Provider        Provider
	SubjectField    string
	QualificationID string
	StatusSupported bool
	IsCurrent       func(context.Context) (bool, error)
	Prepare         func(context.Context, []string, time.Duration) (Command, error)
}

// Ports supplies native selection and real subject validation. Select is
// required and may return nil when no qualified installation is available.
// DecodeSubject is required whenever a qualified Claude subject candidate is
// present. It must apply the real generated subject schema, clock and provenance
// rules, returning its validated result and true or nil and false on rejection.
// The candidate retains UTF-16 units; the reader checks only its native string
// type and C0/DEL controls before invoking the adapter. A fake decoder in a test
// does not qualify the production schema or its domain observation mapping.
type Ports[SubjectValue any] struct {
	Select        func(context.Context) (*Selection, error)
	DecodeSubject func(jsonvalue.UTF16String, string) (*SubjectValue, bool)
}
