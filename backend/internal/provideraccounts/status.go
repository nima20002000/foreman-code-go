package provideraccounts

import (
	"context"
	"errors"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// ReadStatus observes a selected native account without starting authentication
// or mutating account state. It reserves the command, rechecks selection before
// dispatch, always closes transferred ownership, and rechecks after cleanup.
// Domain failures become Unavailable. Other adapter errors retain their identity;
// a cleanup error takes precedence over an earlier inspection error.
//
// The context is passed to selection, preparation and execution. Close has its
// own cleanup lifetime. There is no additional cancellation policy after Close:
// the adapter's final selection check decides whether its snapshot is current.
func ReadStatus[SubjectValue any](ctx context.Context, ports Ports[SubjectValue]) (Status[SubjectValue], error) {
	selected, err := ports.Select(ctx)
	if err != nil {
		return statusFailure[SubjectValue](err)
	}
	if selected == nil {
		return Status[SubjectValue]{State: Unavailable}, nil
	}
	selection := *selected

	var args []string
	switch selection.Provider {
	case Codex:
		args = []string{"login", "status"}
	case Claude:
		args = []string{"auth", "status", "--json"}
	default:
		return Status[SubjectValue]{State: Unavailable}, errors.New("native account selection has an unsupported provider")
	}
	command, err := selection.Prepare(ctx, args, 15*time.Second)
	if err != nil {
		return statusFailure[SubjectValue](err)
	}

	result, inspectionErr := inspectStatus(ctx, selection, command)
	if cleanupErr := command.Close(); cleanupErr != nil {
		return statusFailure[SubjectValue](cleanupErr)
	}
	if inspectionErr != nil {
		return statusFailure[SubjectValue](inspectionErr)
	}
	current, err := selection.IsCurrent(ctx)
	if err != nil {
		return statusFailure[SubjectValue](err)
	}
	if !current {
		return Status[SubjectValue]{State: Unavailable}, nil
	}
	return decodeStatus(ports, selection, result)
}

func inspectStatus(ctx context.Context, selection Selection, command Command) (*CommandResult, error) {
	current, err := selection.IsCurrent(ctx)
	if err != nil {
		return nil, err
	}
	if !current {
		return nil, domainerror.New("PROVIDER_ACCOUNT_INSTALLATION_CHANGED", "The accepted native account installation changed.", 409, nil)
	}
	if !selection.StatusSupported {
		return nil, domainerror.New("PROVIDER_ACCOUNT_UNSUPPORTED", "The native account operation is unsupported.", 409, nil)
	}
	return command.Run(ctx)
}

func statusFailure[SubjectValue any](err error) (Status[SubjectValue], error) {
	status := Status[SubjectValue]{State: Unavailable}
	if _, ok := domainerror.As(err); ok {
		return status, nil
	}
	return status, err
}
