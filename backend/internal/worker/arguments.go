package worker

import (
	"path/filepath"
	"slices"
)

// Action identifies an installed worker CLI operation, not a wire operation.
type Action string

const (
	Help                    Action = "help"
	Run                     Action = "run"
	Doctor                  Action = "doctor"
	Identity                Action = "identity"
	IdentityRequest         Action = "identity-request"
	Pair                    Action = "pair"
	InitializeNativeRuntime Action = "initialize-native-runtime"
	CaptureJobRuntime       Action = "capture-job-runtime"
	RefreshJobRuntime       Action = "refresh-job-runtime"
	CleanupJobBeforeEntry   Action = "cleanup-job-before-entry"
)

// Invocation contains local CLI arguments. Shared domain DTOs belong to the
// generated contracts export and do not cross this parser boundary.
type Invocation struct {
	Action          Action
	StateDirectory  string
	EnrollmentStdin bool
	InputFile       string
}

// ParseArguments retains the installed worker's fixed flag order, explicit
// absolute state selection, and side-effect-free help behavior.
func ParseArguments(arguments []string) (Invocation, error) {
	if len(arguments) == 0 || slices.Contains(arguments, "--help") || slices.Contains(arguments, "-h") {
		return Invocation{Action: Help}, nil
	}
	if len(arguments) < 3 || len(arguments) > 5 || arguments[1] != "--state" || !filepath.IsAbs(arguments[2]) {
		return Invocation{}, usageError()
	}
	invocation := Invocation{Action: Action(arguments[0]), StateDirectory: filepath.Clean(arguments[2])}
	switch invocation.Action {
	case Run, Doctor, Identity, IdentityRequest, InitializeNativeRuntime:
		if len(arguments) != 3 {
			return Invocation{}, usageError()
		}
	case Pair:
		if len(arguments) == 4 && arguments[3] == "--enrollment-stdin" {
			invocation.EnrollmentStdin = true
			return invocation, nil
		}
		if len(arguments) != 5 || arguments[3] != "--enrollment-file" || !filepath.IsAbs(arguments[4]) {
			return Invocation{}, usageError()
		}
		invocation.InputFile = arguments[4]
	case CaptureJobRuntime, RefreshJobRuntime:
		if len(arguments) != 5 || arguments[3] != "--input" || !filepath.IsAbs(arguments[4]) {
			return Invocation{}, usageError()
		}
		invocation.InputFile = arguments[4]
	case CleanupJobBeforeEntry:
		if len(arguments) != 5 || arguments[3] != "--grant" || !filepath.IsAbs(arguments[4]) {
			return Invocation{}, usageError()
		}
		invocation.InputFile = arguments[4]
	default:
		return Invocation{}, usageError()
	}
	return invocation, nil
}

func usageError() error {
	return failure("usage: foreman worker --help", "", nil)
}

// Usage describes existing worker commands using the single Go binary.
func Usage() string {
	return `Foreman Code worker

Usage:
  foreman worker run|doctor|identity|identity-request|initialize-native-runtime --state /absolute/private/state
  foreman worker pair --state /absolute/private/state --enrollment-stdin
  foreman worker pair --state /absolute/private/state --enrollment-file /absolute/private/enrollment.json
  foreman worker capture-job-runtime --state /absolute/private/state --input /absolute/private/capture.json
  foreman worker refresh-job-runtime --state /absolute/private/state --input /absolute/private/refresh.json
  foreman worker cleanup-job-before-entry --state /absolute/private/state --grant /absolute/private/grant.json

Keep application and state in separate private directories. Worker commands use
the explicitly selected state directory; they do not select a default installation.
`
}
