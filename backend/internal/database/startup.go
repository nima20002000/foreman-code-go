package database

import (
	"context"
	"errors"
)

// RetryStartup retries only replay-safe startup database work. It must not wrap
// application initialization that also registers routes or submits native work.
func RetryStartup[T any](ctx context.Context, work func(context.Context) (T, error), options RetryOptions) (T, error) {
	return RetryOperation(ctx, work, isStartupFailure, options)
}

func isStartupFailure(err error) bool {
	if IsTimeout(err) {
		return true
	}
	var seen []error
	for err != nil {
		if seenError(seen, err) {
			return false
		}
		seen = append(seen, err)
		code := errorCode(err)
		if code != "" && code != "GRAPH_TRANSACTION_FAILED" {
			switch code {
			case "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
				"08000", "08001", "08003", "08006", "57P01", "57P02", "57P03", "53300":
				return true
			default:
				return false
			}
		}
		if IsPoolTimeout(err) || err.Error() == "Connection terminated unexpectedly" {
			return true
		}
		err = errors.Unwrap(err)
	}
	return false
}
