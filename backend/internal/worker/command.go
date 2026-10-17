package worker

import (
	"context"
	"fmt"
	"io"

	"github.com/nima20002000/foreman-code-go/backend/internal/command"
)

// Handler receives validated local arguments. Implementations retain their own
// identity, pairing, installation and execution contracts.
type Handler func(context.Context, Invocation) error

// CommandOptions supplies real handlers to the worker CLI. Missing commands fail
// explicitly; the parser never creates an identity or a substitute runtime.
type CommandOptions struct {
	Output   io.Writer
	Handlers map[Action]Handler
}

// Execute handles worker arguments after the top-level "worker" command.
func Execute(ctx context.Context, arguments []string, options CommandOptions) error {
	if err := context.Cause(ctx); err != nil {
		return err
	}
	invocation, err := ParseArguments(arguments)
	if err != nil {
		return err
	}
	if invocation.Action == Help {
		if options.Output == nil {
			return failure("worker_output_unavailable", "Worker command output is unavailable.", nil)
		}
		_, err := io.WriteString(options.Output, Usage())
		return err
	}
	handler := options.Handlers[invocation.Action]
	if handler == nil {
		return failure("worker_command_unavailable", fmt.Sprintf("The worker %s command is not available in this build.", invocation.Action), nil)
	}
	return handler(ctx, invocation)
}

// RegisterCommand installs the adapter without owning the binary's composition
// root. The integrator supplies the concrete runtime handlers there.
func RegisterCommand(registry command.Registry, options CommandOptions) {
	registry[command.Worker] = func(ctx context.Context, arguments []string) error {
		return Execute(ctx, arguments, options)
	}
}
