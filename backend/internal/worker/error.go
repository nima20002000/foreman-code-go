// Package worker implements the local lifecycle of an installed Go worker.
package worker

// Error preserves the worker's public failure codes without exposing local state.
type Error struct {
	Code    string
	Message string
	Cause   error
}

func (err *Error) Error() string {
	if err.Message != "" {
		return err.Message
	}
	return err.Code
}

func (err *Error) Unwrap() error { return err.Cause }

func failure(code, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}
