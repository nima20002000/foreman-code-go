package handoffs

// returnRequestError retains a validation reason from parseWorkResultForInput.
// It is a fresh error for each failure, without a sentinel or wrapped cause.
// The generated-contract adapter still owns the validation class, path and
// valid-request-ID suffix; these reason strings are frozen public wording.
type returnRequestError struct {
	requestIDProvided bool
}

func (e *returnRequestError) Error() string {
	if e.requestIDProvided {
		return "Return requestId must match an open received request."
	}
	return "Return requestId may be omitted only when exactly one received request is open."
}

// ResolveReturnRequestID selects only a received request. The caller derives
// received from the validated activation input and its saved parent context.
// It must not replace that list with all requests in the Run. In particular,
// several received requests require an explicit ID, even if IDs are repeated.
//
// This is the ID decision in parseWorkResultForInput. The generated-contract
// adapter owns the Zod-equivalent path and valid-ID diagnostic; this helper
// neither rewrites the native result nor proves a persisted request is open.
func ResolveReturnRequestID(requested *string, received []string) (string, error) {
	if requested == nil {
		if len(received) != 1 {
			return "", &returnRequestError{}
		}
		return received[0], nil
	}
	for _, id := range received {
		if id == *requested {
			return id, nil
		}
	}
	return "", &returnRequestError{requestIDProvided: true}
}
