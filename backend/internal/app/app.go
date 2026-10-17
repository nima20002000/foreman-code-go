// Package app is the composition surface shared by migration lanes.
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/mcpserver"
)

// Pinger is the public readiness operation implemented by infrastructure dependencies.
type Pinger interface {
	Ping(context.Context) error
}

// Readiness preserves the two independently reported TypeScript dependencies.
type Readiness struct {
	Database    Pinger
	Checkpoints Pinger
}

// MCPAccess supplies the shared generated-principal access implementation.
type MCPAccess = mcpserver.Access

// Options supplies infrastructure; lane Register functions own their domain services.
type Options struct {
	Config              config.Config
	Database            *database.DB
	Logger              *slog.Logger
	Readiness           Readiness
	ReadinessTimeout    time.Duration
	MCPAccess           MCPAccess
	MCPMaxRequestBytes  int64
}

// App is composed before serving. Lanes add HTTP, MCP, streams and background services here.
type App struct {
	Config           config.Config
	Database         *database.DB
	Logger           *slog.Logger
	Readiness        Readiness
	ReadinessTimeout time.Duration
	mux              *http.ServeMux
	errors           httpserver.ErrorHandler
	mcp              *mcpserver.Registry
	services         []backgroundService
}

// New constructs the shared transport boundary without opening a port or contacting a database.
func New(options Options) (*App, error) {
	if options.MCPMaxRequestBytes < 0 {
		return nil, fmt.Errorf("MCP request body limit must be positive")
	}
	timeout := options.ReadinessTimeout
	if timeout == 0 {
		timeout = 2 * time.Second
	}
	if timeout < time.Millisecond || timeout > 2147483647*time.Millisecond || timeout%time.Millisecond != 0 {
		return nil, fmt.Errorf("readinessTimeoutMs must be a positive 32-bit integer")
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	application := &App{
		Config: options.Config, Database: options.Database, Logger: logger,
		Readiness: options.Readiness, ReadinessTimeout: timeout,
		mux: http.NewServeMux(), errors: httpserver.ErrorHandler{Logger: logger},
		mcp: mcpserver.New(mcpserver.Options{
			Access: options.MCPAccess, Logger: logger, MaxRequestBodyBytes: options.MCPMaxRequestBytes,
		}),
	}
	application.Handle("/", func(http.ResponseWriter, *http.Request) error {
		return domainerror.New("NOT_FOUND", "The requested API route was not found.", 404, nil)
	})
	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodDelete} {
		application.Handle(method+" /mcp", application.mcp.Handle)
	}
	return application, nil
}

// Handle registers a method/path pattern using the common DomainError envelope.
// A handler writes its success reply and returns failures before committing a response.
func (a *App) Handle(pattern string, handler httpserver.Handler) {
	a.mux.Handle(pattern, a.errors.Wrap(handler))
}

// RegisterStream applies the same error boundary to an SSE or WebSocket endpoint.
func (a *App) RegisterStream(pattern string, handler httpserver.Handler) {
	a.Handle(pattern, handler)
}

// RegisterTool adds an authenticated tool and the validator generated from its shared schema.
func (a *App) RegisterTool(tool *mcp.Tool, validate func(json.RawMessage) error, handler mcp.ToolHandler) {
	a.mcp.RegisterTool(tool, validate, handler)
}

// Handler exposes the composed app through the standard HTTP public interface.
func (a *App) Handler() http.Handler {
	return httpserver.WithRequestID(a.mux)
}
