package worker_test

import (
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func requireWorkerError(t *testing.T, err error, code string) {
	t.Helper()
	var typed *worker.Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("error = %v; want worker code %s", err, code)
	}
}
