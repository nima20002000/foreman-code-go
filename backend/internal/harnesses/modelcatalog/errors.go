package modelcatalog

// Error preserves the frozen native catalog diagnostic without exposing a
// provider's private stdout, stderr, or underlying failure in Error().
type Error struct {
	Code      string
	Message   string
	Retryable bool
	cause     error
}

func (e *Error) Error() string       { return e.Message }
func (e *Error) Unwrap() error       { return e.cause }
func (e *Error) FailureCode() string { return e.Code }

// CleanupError retains both failed inspection and failed physical cleanup.
// CleanupCause corresponds to the frozen AggregateError's cleanup cause.
type CleanupError struct {
	InspectionCause error
	CleanupCause    error
}

func (e *CleanupError) Error() string {
	return "Native model inspection and cleanup failed."
}

func (e *CleanupError) Unwrap() []error {
	return []error{e.InspectionCause, e.CleanupCause}
}

func invalidCatalog(cause error) *Error {
	return &Error{Code: "CODEX_MODEL_CATALOG_INVALID", Message: "Codex returned an invalid model catalog.", cause: cause}
}

func invalidMCP() *Error {
	return &Error{Code: "CODEX_MCP_INSPECTION_FAILED", Message: "Codex MCP configuration inspection failed; absence was not established."}
}
