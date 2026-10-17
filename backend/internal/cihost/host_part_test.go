package cihost_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/cihost"
)

func TestHostPartStartRequiresNativeCommandPort(t *testing.T) {
	if _, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{}, nil); err == nil {
		t.Fatal("constructed a host executor without its native owner")
	}
}

func TestHostPartStartPreservesNativeFailureWithoutFallback(t *testing.T) {
	want := errors.New("native worker channel unavailable")
	calls := 0
	executor, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
		calls++
		return cihost.HostCiCommand{}, want
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := executor.Start(context.Background(), cihost.HostPartLaunch{RunID: "owned-part"}); !errors.Is(err, want) || calls != 1 {
		t.Fatalf("failed native start must not launch a fallback: calls=%d err=%v", calls, err)
	}
}

func TestHostPartStartReportsBoundedManagerRejection(t *testing.T) {
	executor, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
		return cihost.HostCiCommand{Code: 1, Stderr: "  " + strings.Repeat("x", 700) + "  "}, nil
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = executor.Start(context.Background(), cihost.HostPartLaunch{RunID: "owned-part"})
	if err == nil || err.Error() != "The CI unit could not start: "+strings.Repeat("x", 500) {
		t.Fatalf("unexpected start rejection: %v", err)
	}
}

func TestHostPartStartPreservesManagerRejectionMessage(t *testing.T) {
	for _, fixture := range []struct {
		name, stderr, message string
	}{
		{"short", "  Access denied.\n", "The CI unit could not start: Access denied."},
		{"blank", " \t\r\n ", "The CI unit could not start: "},
		{"multiline", "\nFailed to connect to bus:\nPermission denied.\n", "The CI unit could not start: Failed to connect to bus:\nPermission denied."},
		{"multibyte", "\t" + strings.Repeat("界", 501) + "\n", "The CI unit could not start: " + strings.Repeat("界", 500)},
		{"surrogate-pairs", strings.Repeat("\U0001F600", 251), "The CI unit could not start: " + strings.Repeat("\U0001F600", 250)},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			executor, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
				return cihost.HostCiCommand{Code: 1, Stderr: fixture.stderr}, nil
			}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			err = executor.Start(context.Background(), cihost.HostPartLaunch{RunID: "owned-part"})
			if err == nil || err.Error() != fixture.message {
				t.Fatalf("manager rejection message changed: got %v, want %q", err, fixture.message)
			}
		})
	}
}

func TestHostPartCanceledBeforeLaunchMakesNoNativeCall(t *testing.T) {
	calls := 0
	executor, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
		calls++
		return cihost.HostCiCommand{}, nil
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := executor.Start(ctx, cihost.HostPartLaunch{RunID: "owned-part"}); !errors.Is(err, context.Canceled) || calls != 0 {
		t.Fatalf("canceled start reached the manager: calls=%d err=%v", calls, err)
	}
}

func TestHostPartStopNeedsTerminalObservation(t *testing.T) {
	active := true
	executor, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{Run: func(_ context.Context, _ string, args []string, _ cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
		if args[1] == "stop" {
			return cihost.HostCiCommand{}, nil
		}
		state := "inactive"
		if active {
			state = "deactivating"
		}
		return cihost.HostCiCommand{Stdout: "Id=foreman-ci-owned-part.service\nLoadState=loaded\nActiveState=" + state + "\n"}, nil
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if command, err := executor.Stop(context.Background(), "owned-part"); err != nil || command.Code != 0 {
		t.Fatalf("stop acknowledgement: command=%v err=%v", command, err)
	}
	states, err := executor.UnitStates(context.Background(), []string{"owned-part"})
	if err != nil || states["owned-part"] != cihost.HostCiUnitActive {
		t.Fatalf("acknowledgement was treated as completed cancellation: states=%v err=%v", states, err)
	}
	active = false
	states, err = executor.UnitStates(context.Background(), []string{"owned-part"})
	if err != nil || states["owned-part"] != cihost.HostCiUnitStopped {
		t.Fatalf("terminal observation was not retained: states=%v err=%v", states, err)
	}
}
