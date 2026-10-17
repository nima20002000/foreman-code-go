package command_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/command"
)

func TestDispatchPreservesCommandArgumentsAndHandlerError(t *testing.T) {
	failure := errors.New("worker connection failed")
	var received []string
	err := command.Run(context.Background(), []string{"worker", "--pairing", "isolated-worker"}, command.Registry{
		command.Worker: func(_ context.Context, arguments []string) error {
			received = arguments
			return failure
		},
	})
	if err != failure || !reflect.DeepEqual(received, []string{"--pairing", "isolated-worker"}) {
		t.Fatalf("Unexpected dispatch: arguments=%v, error=%v", received, err)
	}
}

func TestHelperStubsAreExplicitAndDoNotStartAnotherCommand(t *testing.T) {
	names := []command.Name{command.Guardian, command.MCPLauncher, command.RsyncWriter,
		command.RefreshJobRuntime, command.CaptureJobRuntime, command.FormatHelper}
	for _, name := range names {
		t.Run(string(name), func(t *testing.T) {
			err := command.Run(context.Background(), []string{string(name)}, command.Registry{
				command.Serve: func(context.Context, []string) error {
					t.Fatal("A helper stub started the API")
					return nil
				},
			})
			var unavailable *command.UnavailableError
			if !errors.As(err, &unavailable) || unavailable.Command != name {
				t.Fatalf("Expected an unavailable helper, got %v", err)
			}
		})
	}
}

func TestDispatchRequiresAKnownCommand(t *testing.T) {
	for _, arguments := range [][]string{nil, {"missing"}} {
		var usage *command.UsageError
		if err := command.Run(context.Background(), arguments, nil); !errors.As(err, &usage) {
			t.Fatalf("Expected a usage error, got %v", err)
		}
	}
}

func TestDispatchDoesNotStartAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("shutdown requested")
	cancel(cause)
	err := command.Run(ctx, []string{"serve"}, command.Registry{
		command.Serve: func(context.Context, []string) error {
			t.Fatal("Cancelled dispatch started the API")
			return nil
		},
	})
	if err != cause {
		t.Fatalf("Expected cancellation cause, got %v", err)
	}
}
