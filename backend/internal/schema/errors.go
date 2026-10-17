package schema

import "fmt"

// An incompatible database can still have a transient inspection failure.
// Keep one cause so database retry predicates can follow the original failure.
type incompatibleError struct {
	operation string
	cause     error
}

func incompatibleCause(operation string, cause error) error {
	return &incompatibleError{operation: operation, cause: cause}
}

func (err *incompatibleError) Error() string {
	return fmt.Sprintf("%v: %s: %v", ErrIncompatible, err.operation, err.cause)
}

func (err *incompatibleError) Is(target error) bool {
	return target == ErrIncompatible
}

func (err *incompatibleError) Unwrap() error { return err.cause }
