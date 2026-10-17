package config

// ValidationError identifies a rejected environment setting without retaining its
// value. Message is the public configuration diagnostic, including the wording
// and punctuation preserved from the TypeScript contract.
type ValidationError struct {
	Setting string
	Message string
}

// Error returns the public diagnostic displayed by configuration consumers.
func (err *ValidationError) Error() string { return err.Message }
