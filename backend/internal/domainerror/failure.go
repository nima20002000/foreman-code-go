package domainerror

import (
	"errors"

	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

// PublicFailureClass omits permanent failures and an already explicit details.retryable flag.
func PublicFailureClass(err error) string {
	if domain, ok := As(err); ok {
		if _, stated := domain.Details["retryable"].(bool); stated {
			return ""
		}
	}
	class := classify(err)
	if class == "permanent" {
		return ""
	}
	return class
}

func classify(err error) string {
	var timed interface{ Timeout() bool }
	if errors.As(err, &timed) && timed.Timeout() {
		return "transient"
	}
	if class, found := deviceFailureClasses[failureCode(err)]; found {
		return class
	}
	if domain, ok := As(err); ok {
		if validClass(domain.FailureClass) {
			return domain.FailureClass
		}
		if retryable, stated := domain.Details["retryable"].(bool); stated {
			if retryable {
				return "transient"
			}
			return "permanent"
		}
	}
	var classified interface{ DeclaredFailureClass() string }
	if errors.As(err, &classified) {
		if class := classified.DeclaredFailureClass(); validClass(class) {
			return class
		}
	}
	if database.IsTransientConnection(err) {
		return "transient"
	}
	return "permanent"
}

func validClass(class string) bool {
	return class == "permanent" || class == "transient" || class == "cancelled"
}
