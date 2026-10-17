// Package command dispatches the commands of the single foreman binary.
package command

import (
	"context"
	"fmt"
	"strings"
)

// Name is an existing server, worker, or helper entrypoint.
type Name string

const (
	Serve             Name = "serve"
	Worker            Name = "worker"
	Guardian          Name = "guardian"
	MCPLauncher       Name = "mcp-launcher"
	RsyncWriter       Name = "rsync-writer"
	RefreshJobRuntime Name = "refresh-job-runtime"
	CaptureJobRuntime Name = "capture-job-runtime"
	FormatHelper      Name = "format-helper"
)

var names = []Name{Serve, Worker, Guardian, MCPLauncher, RsyncWriter, RefreshJobRuntime, CaptureJobRuntime, FormatHelper}

// Handler receives command-specific arguments unchanged. The composition root owns wiring.
type Handler func(context.Context, []string) error

// Registry allows each helper owner to install its command without another binary.
type Registry map[Name]Handler

// Usage describes the supported command names without starting a runtime.
func Usage() string {
	commands := make([]string, len(names))
	for index, name := range names {
		commands[index] = string(name)
	}
	return "Usage: foreman <command> [arguments]\nCommands: " + strings.Join(commands, ", ") + "\n"
}

// UsageError indicates an absent or unrecognized command.
type UsageError struct{ Command string }

func (err *UsageError) Error() string {
	if err.Command == "" {
		return "A foreman command is required."
	}
	return fmt.Sprintf("Unknown foreman command %q.", err.Command)
}

// UnavailableError keeps unimplemented helper entrypoints explicit.
type UnavailableError struct{ Command Name }

func (err *UnavailableError) Error() string {
	return fmt.Sprintf("The %s command is not available in this build.", err.Command)
}

// Run dispatches one known command. Stub helpers return an error without side effects.
func Run(ctx context.Context, arguments []string, registry Registry) error {
	if err := context.Cause(ctx); err != nil {
		return err
	}
	if len(arguments) == 0 {
		return &UsageError{}
	}
	name := Name(arguments[0])
	known := false
	for _, candidate := range names {
		if name == candidate {
			known = true
			break
		}
	}
	if !known {
		return &UsageError{Command: string(name)}
	}
	handler := registry[name]
	if handler == nil {
		return &UnavailableError{Command: name}
	}
	return handler(ctx, arguments[1:])
}
