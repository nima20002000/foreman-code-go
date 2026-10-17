package cihost_test

import (
	"context"
	"errors"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/cihost"
)

func TestHostCiUnitStatesMatchReorderedObservations(t *testing.T) {
	ports := cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
		return cihost.HostCiCommand{Stdout: "Id=second.service\nLoadState=loaded\nActiveState=failed\n\nId=unrequested.service\nLoadState=loaded\nActiveState=active\n\nId=first.service\nLoadState=loaded\nActiveState=deactivating\n"}, nil
	}}
	states, err := cihost.ReadHostCiUnitStates(context.Background(), ports, []string{"first.service", "second.service", "absent.service"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 3 || states["first.service"] != cihost.HostCiUnitActive || states["second.service"] != cihost.HostCiUnitStopped || states["absent.service"] != cihost.HostCiUnitUnknown {
		t.Fatalf("unexpected native observations: %v", states)
	}
}

func TestHostCiUnitStatesPreserveUnknownOnUnavailableManager(t *testing.T) {
	for _, observation := range []struct {
		name   string
		result cihost.HostCiCommand
	}{
		{"failure", cihost.HostCiCommand{Code: 1, Stdout: "Id=part.service\nLoadState=loaded\nActiveState=inactive\n"}},
		{"timeout", cihost.HostCiCommand{TimedOut: true, Stdout: "Id=part.service\nLoadState=loaded\nActiveState=inactive\n"}},
		{"partial", cihost.HostCiCommand{Stdout: "Id=part.service\nActiveState=inactive\n"}},
		{"unrecognized", cihost.HostCiCommand{Stdout: "Id=part.service\nLoadState=loaded\nActiveState=refreshing\n"}},
	} {
		t.Run(observation.name, func(t *testing.T) {
			ports := cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
				return observation.result, nil
			}}
			states, err := cihost.ReadHostCiUnitStates(context.Background(), ports, []string{"part.service"}, nil)
			if err != nil || states["part.service"] != cihost.HostCiUnitUnknown {
				t.Fatalf("unavailable observation released service ownership: states=%v err=%v", states, err)
			}
		})
	}
}

func TestHostCiUnitStatesKeepTransientManagerStatesActive(t *testing.T) {
	for _, state := range []string{"active", "activating", "reloading", "deactivating", "inactive", "failed"} {
		t.Run(state, func(t *testing.T) {
			ports := cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
				return cihost.HostCiCommand{Stdout: "Id=part.service\nLoadState=loaded\nActiveState=" + state + "\n"}, nil
			}}
			states, err := cihost.ReadHostCiUnitStates(context.Background(), ports, []string{"part.service"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			want := cihost.HostCiUnitActive
			if state == "inactive" || state == "failed" {
				want = cihost.HostCiUnitStopped
			}
			if states["part.service"] != want {
				t.Fatalf("observed %s as %s, want %s", state, states["part.service"], want)
			}
		})
	}
}

func TestHostCiUnitStatesDoNotInventObservationAfterNativeFailure(t *testing.T) {
	want := errors.New("worker command channel closed")
	ports := cihost.HostCiPorts{Run: func(context.Context, string, []string, cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
		return cihost.HostCiCommand{}, want
	}}
	states, err := cihost.ReadHostCiUnitStates(context.Background(), ports, []string{"part.service"}, nil)
	if !errors.Is(err, want) || states != nil {
		t.Fatalf("native observation failure was hidden: states=%v err=%v", states, err)
	}
}

func TestHostCiUnitStatesEmptyRequestNeedsNoNativeCommand(t *testing.T) {
	states, err := cihost.ReadHostCiUnitStates(context.Background(), cihost.HostCiPorts{}, nil, nil)
	if err != nil || len(states) != 0 {
		t.Fatalf("empty observation: states=%v err=%v", states, err)
	}
}
