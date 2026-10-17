package cihost

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const hostCiUnitRuntimeSeconds = 3 * 60 * 60

// HostPartLaunch contains the already prepared native launch inputs from
// HostCiRunner.launchRun. It is not a replacement for generated CiHostRequest,
// CiHostReply, admission, repository preparation, or permission checks.
type HostPartLaunch struct {
	RunID            string
	WorkingDirectory string
	Script           string
	StoppedScript    string
	CPUCount         int
	MemoryBytes      int64
	Warmup           bool
}

// HostPartExecutor starts one prepared part as a transient user service. The
// service owns its process group and survives a worker restart. Observations
// come from systemd; accepting a stop command is not evidence that it stopped.
type HostPartExecutor struct {
	ports       HostCiPorts
	environment map[string]string
}

func NewHostPartExecutor(ports HostCiPorts, environment map[string]string) (*HostPartExecutor, error) {
	if ports.Run == nil {
		return nil, errors.New("host CI requires a native command port")
	}
	return &HostPartExecutor{ports: ports, environment: maps.Clone(environment)}, nil
}

// Start returns only the manager's launch acknowledgement. A timeout or failed
// acknowledgement must be reconciled against the same service identity; it
// must never trigger an unmanaged execution fallback.
func (executor *HostPartExecutor) Start(ctx context.Context, launch HostPartLaunch) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	stopSeconds := 30
	if launch.Warmup {
		stopSeconds = 2
	}
	args := []string{
		"--user", "--quiet", "--collect", "--unit=" + hostCiUnitName(launch.RunID),
		fmt.Sprintf("--property=MemoryMax=%d", launch.MemoryBytes),
		fmt.Sprintf("--property=CPUQuota=%d%%", launch.CPUCount*100),
		fmt.Sprintf("--property=RuntimeMaxSec=%d", hostCiUnitRuntimeSeconds),
		fmt.Sprintf("--property=TimeoutStopSec=%d", stopSeconds),
	}
	if launch.Warmup {
		args = append(args, "--property=Nice=19", "--property=CPUWeight=1", "--property=IOWeight=1", "--property=IOSchedulingClass=idle")
	}
	stoppedScript := strings.ReplaceAll(strconv.Quote(launch.StoppedScript), "%", "%%")
	args = append(args, "--property=KillMode=control-group",
		"--property=ExecStopPost=/bin/bash "+stoppedScript,
		"--property=UMask=0022", "--working-directory="+launch.WorkingDirectory)
	for _, key := range []string{"PATH", "HOME", "USER", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
		if value := executor.environment[key]; value != "" {
			args = append(args, "--setenv="+key+"="+value)
		}
	}
	args = append(args, "/bin/bash", launch.Script)
	started, err := executor.ports.Run(ctx, "systemd-run", args, HostCiCommandOptions{
		Environment: maps.Clone(executor.environment), Timeout: 30 * time.Second,
	})
	if err != nil {
		return err
	}
	if started.Code != 0 {
		return &hostPartStartRejection{detail: hostCiFailureText(started.Stderr)}
	}
	return nil
}

// hostPartStartRejection keeps the bounded manager diagnostic separate from
// the user-facing report, whose wording is fixed by HostCiRunner.launchRun.
type hostPartStartRejection struct {
	detail string
}

func (rejection *hostPartStartRejection) Error() string {
	return "The CI unit could not start: " + rejection.detail
}

// Stop requests the manager to stop the retained service. Call UnitStates after
// acknowledgement to determine whether cancellation has actually completed.
func (executor *HostPartExecutor) Stop(ctx context.Context, runID string) (HostCiCommand, error) {
	if err := ctx.Err(); err != nil {
		return HostCiCommand{}, err
	}
	return executor.ports.Run(ctx, "systemctl", []string{"--user", "stop", hostCiServiceUnit(runID)},
		HostCiCommandOptions{Environment: maps.Clone(executor.environment)})
}

func (executor *HostPartExecutor) UnitStates(ctx context.Context, runIDs []string) (map[string]HostCiUnitState, error) {
	units := make([]string, 0, len(runIDs))
	for _, runID := range runIDs {
		units = append(units, hostCiServiceUnit(runID))
	}
	states, err := ReadHostCiUnitStates(ctx, executor.ports, units, executor.environment)
	if err != nil {
		return nil, err
	}
	result := make(map[string]HostCiUnitState, len(runIDs))
	for _, runID := range runIDs {
		result[runID] = states[hostCiServiceUnit(runID)]
	}
	return result, nil
}

func hostCiUnitName(runID string) string {
	return "foreman-ci-" + runID
}

func hostCiServiceUnit(runID string) string {
	return hostCiUnitName(runID) + ".service"
}

func hostCiFailureText(text string) string {
	// The reference uses trim().slice(0, 500), whose bound is UTF-16 code units.
	units := utf16.Encode([]rune(strings.TrimSpace(text)))
	if len(units) > 500 {
		units = units[:500]
	}
	return string(utf16.Decode(units))
}
