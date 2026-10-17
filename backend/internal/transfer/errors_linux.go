package transfer

// stagingFailureReason identifies a local staging condition, without assigning
// a transport error code or status.
type stagingFailureReason uint8

const (
	committedBytesFailure stagingFailureReason = iota
	invalidChunkFailure
	allocationFailure
	offsetFailure
	duplicateFailure
	wholeIntegrityFailure
	relativeRootFailure
	unsafeRootFailure
	unsafeAncestorFailure
	privateRootFailure
	unsafeNameFailure
	invalidLimitsFailure
	unsafeFileFailure
)

// stagingFailure keeps the condition separate from its reported wording. Each
// instance has pointer identity; equal conditions do not make fresh errors equal.
// It deliberately adds no cause or transport classification.
type stagingFailure struct {
	reason stagingFailureReason
}

// Error reports the existing staging messages verbatim, including the frozen
// TypeScript wording. Callers may wrap or join them without rewriting the text.
func (failure *stagingFailure) Error() string {
	switch failure.reason {
	case committedBytesFailure:
		return "Committed transfer bytes missing or corrupt; restart byte attempt explicitly"
	case invalidChunkFailure:
		return "Invalid transfer chunk"
	case allocationFailure:
		return "Chunk exceeds allocation"
	case offsetFailure:
		return "Chunk offset conflict"
	case duplicateFailure:
		return "Conflicting duplicate chunk"
	case wholeIntegrityFailure:
		return "Whole transfer integrity mismatch"
	case relativeRootFailure:
		return "Transfer root must be absolute"
	case unsafeRootFailure:
		return "Unsafe transfer root"
	case unsafeAncestorFailure:
		return "Unsafe transfer ancestor"
	case privateRootFailure:
		return "Transfer root must be private and owned"
	case unsafeNameFailure:
		return "Unsafe staging file name"
	case invalidLimitsFailure:
		return "Invalid staging limits"
	case unsafeFileFailure:
		return "Unsafe transfer file"
	default:
		return "unknown staging failure"
	}
}
