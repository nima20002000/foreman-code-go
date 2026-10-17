// Package domainerror keeps the public failure contract shared by HTTP and MCP.
package domainerror

import "errors"

// Error is a domain failure safe to expose at a transport boundary. Cause stays private.
type Error struct {
	Code          string
	Message       string
	Status        int
	Details       map[string]any
	Cause         error
	FailureClass  string
	DenialAudited bool
}

// New constructs the same public failure carried by the TypeScript DomainError.
func New(code, message string, status int, details map[string]any) *Error {
	return &Error{Code: code, Message: message, Status: status, Details: details}
}

func (e *Error) Error() string { return e.Message }

func (e *Error) Unwrap() error { return e.Cause }

// FailureCode lets shared retry predicates inspect an error without a transport dependency.
func (e *Error) FailureCode() string { return e.Code }

// DeclaredFailureClass exposes an explicit classification to the shared database retry policy.
func (e *Error) DeclaredFailureClass() string {
	if validClass(e.FailureClass) {
		return e.FailureClass
	}
	if retryable, stated := e.Details["retryable"].(bool); stated {
		if retryable {
			return "transient"
		}
		return "permanent"
	}
	return ""
}

// As finds a domain failure even when a service has added private error context.
func As(err error) (*Error, bool) {
	var domain *Error
	ok := errors.As(err, &domain)
	return domain, ok
}

func failureCode(err error) string {
	var coded interface{ FailureCode() string }
	if errors.As(err, &coded) {
		return coded.FailureCode()
	}
	var state interface{ SQLState() string }
	if errors.As(err, &state) {
		return state.SQLState()
	}
	return ""
}
