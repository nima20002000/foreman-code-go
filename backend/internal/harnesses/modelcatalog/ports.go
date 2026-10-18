package modelcatalog

import (
	"context"
	"encoding/json"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
)

// CommandResult is a native child-process result. A nil exit code is not success.
type CommandResult struct {
	ExitCode *int
	Stdout   string
	Stderr   string
}

// Command describes the explicit owning host's native MCP configuration read.
type Command struct {
	Binary      string
	Arguments   []string
	Directory   string
	Environment map[string]string
}

// Session is the existing generated Codex client plus its owning process's close
// boundary. Production Close must drain stderr and confirm physical process exit;
// closing codex.Transport's streams alone does not satisfy that ownership duty.
type Session interface {
	Start(context.Context) error
	ListModels(context.Context, protocol.V2ModelListParams) (protocol.V2ModelListResponse, error)
	Reject(context.Context, json.RawMessage, int, string) error
	Close() error
}

// OpenOptions carries the metadata-only policy to the native process adapter.
// Open must not initialize or read the transport until Session.Start is called.
// OnRefreshFailure may run on the process's stderr reader and during Close.
type OpenOptions struct {
	Binary           string
	Directory        string
	Environment      map[string]string
	DisabledMCPNames []string
	OnRequest        func(context.Context, codex.Request) error
	OnRefreshFailure func()
}

// Inspection supplies already-qualified native installation and process ports.
// Adapters own protocol validation from that installation, guardian/recovery
// registration, spawning, and native argument application. No default adapter
// silently uses the current host's executable, environment, or credentials.
type Inspection struct {
	Binary          string
	ProviderVersion string
	AssertUnchanged func(context.Context) error
	RunCommand      func(context.Context, Command) (CommandResult, error)
	Open            func(context.Context, OpenOptions) (Session, error)
}
