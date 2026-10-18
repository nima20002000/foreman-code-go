// Package mcpserver owns the authenticated Foreman MCP endpoint and tool boundary.
package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

// Access binds generated principals to the request context and applies existing tool policies.
// Authenticate also enforces the application's local Host and Origin policy.
type Access interface {
	Authenticate(*http.Request) (context.Context, error)
	Visible(context.Context, string) (bool, error)
	Authorize(context.Context, string, json.RawMessage) error
}

// Options supplies the shared access implementation and transport limits.
type Options struct {
	Access              Access
	Logger              *slog.Logger
	MaxRequestBodyBytes int64
	// JSONResponse forwards the official SDK's explicit JSON response mode.
	// The default is SSE; both modes require the same Accept header.
	JSONResponse bool
}

// Registry collects lane tools before serving requests. Every invocation is authorized.
type Registry struct {
	opts       Options
	mu         sync.RWMutex
	tools      []registration
	validation *mcp.Server
}

type registration struct {
	definition *mcp.Tool
	validate   func(json.RawMessage) error
	handle     mcp.ToolHandler
}

// New constructs the /mcp transport without creating a listener or starting background work.
func New(options Options) *Registry {
	if options.MaxRequestBodyBytes == 0 {
		options.MaxRequestBodyBytes = 1_000_000
	}
	if options.MaxRequestBodyBytes < 0 {
		panic("MCP request body limit must be positive")
	}
	return &Registry{opts: options, validation: newServer(options.Logger)}
}

func newServer(logger *slog.Logger) *mcp.Server {
	return mcp.NewServer(&mcp.Implementation{
		Name: "foreman-code", Title: "Foreman Code MCP", Version: "1.0.0",
	}, &mcp.ServerOptions{
		Logger: logger, Capabilities: &mcp.ServerCapabilities{},
		// The SDK's documented empty-ID mode creates one ephemeral session per request.
		// It keeps legacy protocol negotiation without a process-wide debug switch.
		GetSessionID: func() string { return "" },
	})
}

// RegisterTool adds a tool with a validator generated from packages/contracts.
// Call only during lane registration. Invalid or duplicate definitions fail at startup.
func (r *Registry) RegisterTool(tool *mcp.Tool, validate func(json.RawMessage) error, handle mcp.ToolHandler) {
	if tool == nil || validate == nil || handle == nil {
		panic("MCP registration requires a tool, generated validator, and handler")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, existing := range r.tools {
		if existing.definition.Name == tool.Name {
			panic(fmt.Sprintf("MCP tool %q is already registered", tool.Name))
		}
	}
	// Let the official SDK validate schema metadata during composition, before any request.
	r.validation.AddTool(tool, handle)
	r.tools = append(r.tools, registration{definition: tool, validate: validate, handle: handle})
}

// Handle authenticates before reading the bounded request body or dispatching MCP work.
func (r *Registry) Handle(w http.ResponseWriter, request *http.Request) error {
	if r.opts.Access == nil {
		if request.Header.Get("Authorization") == "" {
			return domainerror.New("AUTH_REQUIRED", "A bearer credential is required.", 401, nil)
		}
		return domainerror.New("MCP_UNAVAILABLE", "The Foreman Code MCP access service is unavailable.", 503, nil)
	}
	ctx, err := r.opts.Access.Authenticate(request)
	if err != nil {
		return err
	}
	if ctx == nil {
		return fmt.Errorf("MCP authentication returned no request context")
	}
	request = request.WithContext(ctx)
	if request.Method != http.MethodPost {
		return httpserver.WriteJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32000, "message": "Method not allowed."},
		})
	}
	name, body, err := requestedTool(w, request, r.opts.MaxRequestBodyBytes)
	if err != nil {
		return err
	}
	if bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
		return r.serveBatch(w, request, body)
	}
	server, err := r.serverFor(ctx, name)
	if err != nil {
		return err
	}
	r.streamableHandler(server).ServeHTTP(w, request)
	return nil
}

func (r *Registry) streamableHandler(server *mcp.Server) *mcp.StreamableHTTPHandler {
	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{
			Logger: r.opts.Logger, MaxRequestBodyBytes: r.opts.MaxRequestBodyBytes,
			PropagateRequestCancellation: true,
			JSONResponse:                 r.opts.JSONResponse,
		})
}

func (r *Registry) serverFor(ctx context.Context, requested string) (*mcp.Server, error) {
	r.mu.RLock()
	tools := append([]registration(nil), r.tools...)
	r.mu.RUnlock()
	server := newServer(r.opts.Logger)
	for _, tool := range tools {
		visible, err := r.opts.Access.Visible(ctx, tool.definition.Name)
		if err != nil {
			return nil, err
		}
		// A known hidden tool still reaches authorization so it returns the domain denial.
		// Listing requests only see visible tools.
		if visible || tool.definition.Name == requested {
			server.AddTool(tool.definition, r.authorized(tool, ctx))
		}
	}
	return server, nil
}

func (r *Registry) authorized(tool registration, requestContext context.Context) mcp.ToolHandler {
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		ctx, cancel := context.WithCancel(ctx)
		stopCancellation := context.AfterFunc(requestContext, cancel)
		defer stopCancellation()
		defer cancel()
		arguments := request.Params.Arguments
		if err := r.opts.Access.Authorize(ctx, tool.definition.Name, arguments); err != nil {
			return ToolFailure(err), nil
		}
		if err := tool.validate(arguments); err != nil {
			return ToolFailure(err), nil
		}
		result, err := tool.handle(ctx, request)
		if err != nil {
			if _, public := domainerror.As(err); !public && r.opts.Logger != nil {
				r.opts.Logger.Error("MCP tool failed", "tool", tool.definition.Name, "error", err)
			}
			return ToolFailure(err), nil
		}
		return result, nil
	}
}
