package cihost

import (
	"context"
	"maps"
	"strings"
)

// HostCiUnitState is a native systemd observation, not a CiHostRun outcome.
type HostCiUnitState string

const (
	HostCiUnitUnknown HostCiUnitState = "unknown"
	HostCiUnitActive  HostCiUnitState = "active"
	HostCiUnitStopped HostCiUnitState = "stopped"
)

// ReadHostCiUnitStates matches replies by Id because systemd can reorder its
// records. Missing, partial, failed and timed-out observations stay unknown;
// callers must retain ownership of such runs rather than declare them lost.
func ReadHostCiUnitStates(ctx context.Context, ports HostCiPorts, units []string, environment map[string]string) (map[string]HostCiUnitState, error) {
	states := make(map[string]HostCiUnitState, len(units))
	args := []string{"--user", "show", "--property=Id", "--property=LoadState", "--property=ActiveState"}
	for _, unit := range units {
		if _, exists := states[unit]; !exists {
			states[unit] = HostCiUnitUnknown
			args = append(args, unit)
		}
	}
	if len(states) == 0 {
		return states, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result, err := ports.Run(ctx, "systemctl", args, HostCiCommandOptions{Environment: maps.Clone(environment)})
	if err != nil {
		return nil, err
	}
	if result.Code != 0 || result.TimedOut {
		return states, nil
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(result.Stdout+"\n\n", "\n") {
		if strings.TrimSpace(line) == "" {
			retainHostCiUnitState(states, fields)
			clear(fields)
			continue
		}
		if key, value, ok := strings.Cut(line, "="); ok {
			fields[key] = value
		}
	}
	return states, nil
}

func retainHostCiUnitState(states map[string]HostCiUnitState, fields map[string]string) {
	unit := fields["Id"]
	if _, requested := states[unit]; !requested || fields["LoadState"] == "" {
		return
	}
	switch fields["ActiveState"] {
	case "active", "activating", "reloading", "deactivating":
		states[unit] = HostCiUnitActive
	case "inactive", "failed":
		states[unit] = HostCiUnitStopped
	}
}
