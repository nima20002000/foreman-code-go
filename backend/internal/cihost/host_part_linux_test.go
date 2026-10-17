package cihost_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/cihost"
)

// This is an injected worker fixture, never a real systemd service. Its only
// child runs a shell built-in in a fresh temporary directory with isolated HOME.
type isolatedHostWorker struct {
	unit        string
	directory   string
	environment []string
	properties  map[string]string
	output      string
	exitCode    int
	timeout     time.Duration
}

func (worker *isolatedHostWorker) run(ctx context.Context, command string, args []string, options cihost.HostCiCommandOptions) (cihost.HostCiCommand, error) {
	if command == "systemctl" {
		return cihost.HostCiCommand{Stdout: "Id=" + worker.unit + ".service\nLoadState=loaded\nActiveState=inactive\n"}, nil
	}
	if command != "systemd-run" {
		return cihost.HostCiCommand{}, fmt.Errorf("fixture received unsupported command %s", command)
	}
	worker.properties = make(map[string]string)
	worker.timeout = options.Timeout
	commandIndex := 0
	for commandIndex < len(args) && strings.HasPrefix(args[commandIndex], "--") {
		arg := args[commandIndex]
		switch {
		case strings.HasPrefix(arg, "--unit="):
			worker.unit = strings.TrimPrefix(arg, "--unit=")
		case strings.HasPrefix(arg, "--working-directory="):
			worker.directory = strings.TrimPrefix(arg, "--working-directory=")
		case strings.HasPrefix(arg, "--setenv="):
			worker.environment = append(worker.environment, strings.TrimPrefix(arg, "--setenv="))
		case strings.HasPrefix(arg, "--property="):
			key, value, _ := strings.Cut(strings.TrimPrefix(arg, "--property="), "=")
			worker.properties[key] = value
		}
		commandIndex++
	}
	if commandIndex == len(args) {
		return cihost.HostCiCommand{}, fmt.Errorf("fixture received no executable")
	}
	child := exec.CommandContext(ctx, args[commandIndex], args[commandIndex+1:]...)
	child.Dir = worker.directory
	child.Env = worker.environment
	output, err := child.CombinedOutput()
	worker.output = string(output)
	worker.exitCode = 0
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			worker.exitCode = exit.ExitCode()
		} else {
			return cihost.HostCiCommand{}, err
		}
	}
	// Acknowledgement is separate from the part's actual exit result.
	return cihost.HostCiCommand{}, nil
}

func TestHostPartRunsPreparedPartOnIsolatedWorker(t *testing.T) {
	for _, warmup := range []bool{false, true} {
		t.Run(strconv.FormatBool(warmup), func(t *testing.T) {
			root := t.TempDir()
			home := filepath.Join(root, "home")
			if err := os.Mkdir(home, 0700); err != nil {
				t.Fatal(err)
			}
			script := filepath.Join(root, "part.sh")
			if err := os.WriteFile(script, []byte("printf 'part-output:%s:%s:%s' \"$PWD\" \"$HOME\" \"${SHOULD_NOT_REACH_UNIT:-absent}\"\nexit 7\n"), 0700); err != nil {
				t.Fatal(err)
			}
			worker := &isolatedHostWorker{}
			executor, err := cihost.NewHostPartExecutor(cihost.HostCiPorts{Run: worker.run}, map[string]string{
				"HOME": home, "PATH": "/usr/bin:/bin", "LANG": "C", "SHOULD_NOT_REACH_UNIT": "private-manager-value",
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			launch := cihost.HostPartLaunch{RunID: "isolated-part", WorkingDirectory: root, Script: script,
				StoppedScript: filepath.Join(root, "stopped.sh"), CPUCount: 3, MemoryBytes: 2 << 30, Warmup: warmup}
			if err := executor.Start(ctx, launch); err != nil {
				t.Fatal(err)
			}
			if worker.output != "part-output:"+root+":"+home+":absent" || worker.exitCode != 7 {
				t.Fatalf("part did not run through the isolated worker: output=%q exit=%d", worker.output, worker.exitCode)
			}
			if worker.properties["CPUQuota"] != "300%" || worker.properties["MemoryMax"] != "2147483648" || worker.properties["RuntimeMaxSec"] != "10800" || worker.properties["KillMode"] != "control-group" {
				t.Fatalf("worker received incorrect execution limits: %v", worker.properties)
			}
			stopSeconds := "30"
			if warmup {
				stopSeconds = "2"
				if worker.properties["Nice"] != "19" || worker.properties["CPUWeight"] != "1" || worker.properties["IOWeight"] != "1" || worker.properties["IOSchedulingClass"] != "idle" {
					t.Fatalf("warmup did not retain low-priority native execution: %v", worker.properties)
				}
			}
			if worker.properties["TimeoutStopSec"] != stopSeconds || worker.timeout != 30*time.Second {
				t.Fatalf("wrong manager deadlines: properties=%v commandTimeout=%s", worker.properties, worker.timeout)
			}
			states, err := executor.UnitStates(ctx, []string{"isolated-part"})
			if err != nil || states["isolated-part"] != cihost.HostCiUnitStopped {
				t.Fatalf("completed fixture part has no stopped observation: states=%v err=%v", states, err)
			}
		})
	}
}
