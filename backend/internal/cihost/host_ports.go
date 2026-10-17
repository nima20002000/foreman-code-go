package cihost

import (
	"context"
	"time"
)

// HostCiCommand is the result of the native command port in the frozen host CI
// runner. TimedOut is separate from Code: an interrupted manager query does not
// establish the state of the service it was querying.
type HostCiCommand struct {
	Code     int
	Stdout   string
	Stderr   string
	TimedOut bool
}

// HostCiCommandOptions describes a native command, not a product request.
// Context carries the TypeScript port's AbortSignal. A supplied LockFD retains
// the repository guard while a preparation command survives its caller.
type HostCiCommandOptions struct {
	CWD         string
	Environment map[string]string
	Timeout     time.Duration
	LockFD      *uintptr
}

// HostCiPorts follows HostCiPorts in apps/api/src/modules/ci-host/runner.ts.
// Native execution is injected by the worker owner; this package deliberately
// supplies no unmanaged process or PID-signaling fallback.
type HostCiPorts struct {
	Run                  func(context.Context, string, []string, HostCiCommandOptions) (HostCiCommand, error)
	Now                  func() time.Time
	CPUs                 int
	MemoryBytes          int64
	AvailableMemoryBytes func() int64
}
