package discovery

// discoveryDiagnostic retains existing discovery diagnostic text verbatim. A pointer
// gives each ordinary failure its own identity; ErrPayloadChanged owns one
// stable instance. These diagnostics do not add a wrapped cause.
type discoveryDiagnostic struct {
	message string
}

func (e *discoveryDiagnostic) Error() string { return e.message }
