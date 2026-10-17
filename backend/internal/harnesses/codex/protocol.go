// Package codex implements Foreman's native Codex JSON-RPC boundary.
package codex

import (
	"context"
	"encoding/json"
	"io"
	"time"
)

// Request is a native protocol envelope. ID preserves both string and numeric IDs.
type Request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Notification is a native event envelope, including Foreman's protocol/malformed event.
type Notification struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Protocol is the frozen TypeScript CodexProtocol port. Qualification must supply
// validators from the actual installation's emitted schema before native execution.
// Generated compile-time types alone never establish compatibility or admission.
type Protocol interface {
	ProviderVersion() string
	Request(Request) error
	Notification(Notification) error
	ServerRequest(Request) error
	Response(method string, result json.RawMessage) error
	ServerResponse(method string, result json.RawMessage) error
}

// Result is a native command result. A late result reconciles an uncertain request;
// it does not authorize replay of the original command.
type Result struct {
	Value json.RawMessage
	Err   error
}

// Options are transport-local ports, not provider qualification evidence.
type Options struct {
	Protocol       Protocol
	RequestTimeout time.Duration
	KnownSecrets   []string
	OnRequest      func(context.Context, Request) error
	OnNotification func(Notification)
	OnDisconnect   func(error)
}

// Streams are an already-owned native process's stdio. Closing either endpoint
// must unblock pending I/O. Process launch, qualification, guardian registration,
// and physical process exit remain with the owning runtime.
type Streams struct {
	Input  io.WriteCloser
	Output io.ReadCloser
}

// Error carries the existing native harness code without exposing a private cause.
type Error struct {
	Code    string
	Message string
	cause   error
}

func (e *Error) Error() string       { return e.Message }
func (e *Error) Unwrap() error       { return e.cause }
func (e *Error) FailureCode() string { return e.Code }

// RPCError distinguishes a native rejection from a submitted command whose outcome
// is unknown. NativeMessage is diagnostic data; Error never echoes it publicly.
type RPCError struct {
	Failure       *Error
	Method        string
	OperationID   json.RawMessage
	Uncertain     bool
	NativeMessage string
}

func (e *RPCError) Error() string       { return e.Failure.Error() }
func (e *RPCError) Unwrap() error       { return e.Failure }
func (e *RPCError) FailureCode() string { return e.Failure.Code }

func rpcError(method string, id json.RawMessage, uncertain bool, code, version string, cause error) *RPCError {
	if version == "" {
		version = "unknown version"
	}
	message := "Codex " + version + " did not accept the " + method + " command contract."
	if uncertain {
		message = "Codex " + version + ": the outcome of " + method + " is uncertain; reconcile before retrying."
	}
	if native, ok := cause.(*Error); ok {
		message = native.Message
	}
	return &RPCError{
		Failure: &Error{Code: code, Message: message, cause: cause},
		Method:  method, OperationID: append(json.RawMessage(nil), id...), Uncertain: uncertain,
	}
}

func failure(code, message string, cause error) *Error {
	return &Error{Code: code, Message: message, cause: cause}
}
