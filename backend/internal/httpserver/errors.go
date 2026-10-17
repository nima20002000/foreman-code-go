// Package httpserver implements Foreman's shared HTTP transport boundary.
package httpserver

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// Handler returns failures to the common HTTP error boundary.
type Handler func(http.ResponseWriter, *http.Request) error

// ErrorHandler writes public domain failures without exposing internal causes.
type ErrorHandler struct {
	Logger *slog.Logger
}

// Wrap applies the common envelope to one route or stream handler.
func (h ErrorHandler) Wrap(next Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writer := &responseWriter{ResponseWriter: w}
		if err := next(writer, r); err != nil {
			if writer.written {
				h.log(err, "HTTP response could not complete")
				return
			}
			h.Write(writer, r, err)
		}
	})
}

// Write sends the TypeScript API error envelope, including its request identifier.
func (h ErrorHandler) Write(w http.ResponseWriter, r *http.Request, err error) {
	writer, tracked := w.(*responseWriter)
	if !tracked {
		writer = &responseWriter{ResponseWriter: w}
	}
	failure := domainerror.DatabaseConnectionFailure(domainerror.DatabaseReadFailure(err))
	domain, ok := domainerror.As(failure)
	if !ok {
		domain = domainerror.New("INTERNAL_ERROR", "The API could not complete the request.", http.StatusInternalServerError, nil)
	}
	if domain.Status >= 500 {
		h.log(err, domain.Message)
	}
	body := map[string]any{
		"code": domain.Code, "message": domain.Message, "requestId": RequestID(r.Context()),
	}
	if domain.Details != nil {
		body["details"] = domain.Details
	}
	if class := domainerror.PublicFailureClass(failure); class != "" {
		body["class"] = class
	}
	if writeErr := WriteJSON(writer, domain.Status, map[string]any{"error": body}); writeErr != nil {
		h.log(writeErr, "HTTP error response could not complete")
		if !writer.written {
			fallback := map[string]any{"error": map[string]any{
				"code": "INTERNAL_ERROR", "message": "The API could not complete the request.",
				"requestId": RequestID(r.Context()),
			}}
			if fallbackErr := WriteJSON(writer, http.StatusInternalServerError, fallback); fallbackErr != nil {
				h.log(fallbackErr, "HTTP fallback response could not complete")
			}
		}
	}
}

func (h ErrorHandler) log(err error, message string) {
	if h.Logger != nil {
		h.Logger.Error(message, "error", err)
	}
}

// WriteJSON marshals before committing headers so invalid values reach the error boundary.
func WriteJSON(w http.ResponseWriter, status int, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, err = w.Write(data)
	return err
}

type responseWriter struct {
	http.ResponseWriter
	written bool
}

func (w *responseWriter) WriteHeader(status int) {
	w.written = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(data []byte) (int, error) {
	w.written = true
	return w.ResponseWriter.Write(data)
}

// Unwrap lets net/http's ResponseController flush and hijack stream responses.
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
