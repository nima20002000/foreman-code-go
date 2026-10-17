package worker_test

import (
	"path/filepath"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func TestWorkerArgumentsPreserveExplicitStateAndInput(t *testing.T) {
	root := t.TempDir()
	state, input := filepath.Join(root, "state"), filepath.Join(root, "input.json")
	separator := string(filepath.Separator)
	uncleanState := root + separator + "unused" + separator + ".." + separator + "state"
	for _, action := range []worker.Action{worker.Run, worker.Doctor, worker.Identity, worker.IdentityRequest, worker.InitializeNativeRuntime} {
		t.Run(string(action), func(t *testing.T) {
			got, err := worker.ParseArguments([]string{string(action), "--state", uncleanState})
			want := worker.Invocation{Action: action, StateDirectory: state}
			if err != nil || got != want {
				t.Fatalf("invocation = %+v, %v; want %+v", got, err, want)
			}
		})
	}
	for _, test := range []struct {
		action worker.Action
		flag   string
	}{
		{worker.Pair, "--enrollment-file"},
		{worker.CaptureJobRuntime, "--input"},
		{worker.RefreshJobRuntime, "--input"},
		{worker.CleanupJobBeforeEntry, "--grant"},
	} {
		t.Run(string(test.action), func(t *testing.T) {
			got, err := worker.ParseArguments([]string{string(test.action), "--state", state, test.flag, input})
			want := worker.Invocation{Action: test.action, StateDirectory: state, InputFile: input}
			if err != nil || got != want {
				t.Fatalf("invocation = %+v, %v; want %+v", got, err, want)
			}
		})
	}
	got, err := worker.ParseArguments([]string{"pair", "--state", state, "--enrollment-stdin"})
	if err != nil || got != (worker.Invocation{Action: worker.Pair, StateDirectory: state, EnrollmentStdin: true}) {
		t.Fatalf("stdin invocation = %+v, %v", got, err)
	}
}

func TestWorkerArgumentsRejectImplicitStateAndMalformedOptions(t *testing.T) {
	state := t.TempDir()
	input := filepath.Join(state, "input.json")
	for _, arguments := range [][]string{
		{"run"},
		{"run", "--state"},
		{"run", "--state", "relative"},
		{"run", "--state", ""},
		{"--state", state, "run"},
		{"unknown", "--state", state},
		{"run", "--state", state, "extra"},
		{"pair", "--state", state},
		{"pair", "--state", state, "--enrollment-file", "relative"},
		{"pair", "--state", state, "--enrollment-stdin", "extra"},
		{"capture-job-runtime", "--state", state, "--grant", input},
		{"refresh-job-runtime", "--state", state, "--input", "relative"},
		{"cleanup-job-before-entry", "--state", state, "--input", input},
		{"cleanup-job-before-entry", "--state", state, "--grant", "relative"},
		{"run", "--state", state, "a", "b", "c"},
	} {
		if _, err := worker.ParseArguments(arguments); err == nil {
			t.Fatalf("arguments %q were accepted", arguments)
		} else {
			requireWorkerError(t, err, "usage: foreman worker --help")
		}
	}
}

func TestWorkerArgumentsHelpTakesPrecedence(t *testing.T) {
	for _, arguments := range [][]string{nil, {"--help"}, {"-h"}, {"nonsense", "--state", "relative", "--help"}} {
		got, err := worker.ParseArguments(arguments)
		if err != nil || got.Action != worker.Help || got.StateDirectory != "" {
			t.Fatalf("help invocation = %+v, %v", got, err)
		}
	}
}
