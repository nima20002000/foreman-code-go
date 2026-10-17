package app_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
)

func bodyApplication(t *testing.T) *app.App {
	t.Helper()
	application, err := app.New(app.Options{Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return application
}

func bodyError(t *testing.T, response *httptest.ResponseRecorder, status int, code, message string) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("error response = %d %q: %v", response.Code, response.Body.String(), err)
	}
	if response.Code != status || envelope.Error.Code != code || envelope.Error.Message != message || envelope.Error.RequestID == "" {
		t.Fatalf("error response = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("error content type = %q", response.Header().Get("Content-Type"))
	}
}

type observedBody struct {
	reader  io.Reader
	reads   int
	entered *bool
}

func (b *observedBody) Read(p []byte) (int, error) {
	b.reads++
	if b.entered != nil && !*b.entered {
		return 0, errors.New("body read before stream handler entered")
	}
	return b.reader.Read(p)
}

func (b *observedBody) Close() error { return nil }

func TestBodyLimitsRejectDeclaredOversizeBeforeHandler(t *testing.T) {
	application := bodyApplication(t)
	called := false
	application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
		called = true
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	body := &observedBody{reader: strings.NewReader("not read")}
	request := httptest.NewRequest(http.MethodPost, "/api/body", nil)
	request.Header.Set("Content-Type", "text/plain")
	request.Body = body
	request.ContentLength = (1 << 20) + 1
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	bodyError(t, response, 413, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.")
	if called || body.reads != 0 || response.Header().Get("Connection") != "close" {
		t.Fatalf("oversize dispatch: handler=%v reads=%d connection=%q", called, body.reads, response.Header().Get("Connection"))
	}
}

func TestBodyLimitsRejectChunkedOversizeBeforeHandler(t *testing.T) {
	application := bodyApplication(t)
	called := false
	application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
		called = true
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	request := httptest.NewRequest(http.MethodPost, "/api/body", strings.NewReader(strings.Repeat("x", (1<<20)+1)))
	request.Header.Set("Content-Type", "text/plain")
	request.ContentLength = -1
	request.TransferEncoding = []string{"chunked"}
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	bodyError(t, response, 413, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.")
	if called {
		t.Fatal("oversize buffered body reached its handler")
	}
}

func TestBodyLimitsAcceptExactBoundary(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		name := "declared"
		if chunked {
			name = "chunked"
		}
		t.Run(name, func(t *testing.T) {
			application := bodyApplication(t)
			payload := bytes.Repeat([]byte("é"), 1<<19)
			application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
				data, err := io.ReadAll(r.Body)
				if err != nil {
					return err
				}
				_, err = w.Write(data)
				return err
			})
			request := httptest.NewRequest(http.MethodPost, "/api/body", bytes.NewReader(payload))
			request.Header.Set("Content-Type", "text/plain; charset=utf-8")
			if chunked {
				request.ContentLength = -1
				request.TransferEncoding = []string{"chunked"}
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), payload) {
				t.Fatalf("exact byte limit response = %d, %d bytes", response.Code, response.Body.Len())
			}
		})
	}
}

func TestBodyLimitsPreserveBufferedBytes(t *testing.T) {
	application := bodyApplication(t)
	payload := "  {\n  \"value\": \"é\", \"n\": 1.00\n}\t"
	application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
		_, err := io.Copy(w, r.Body)
		return err
	})
	request := httptest.NewRequest(http.MethodPost, "/api/body", strings.NewReader(payload))
	request.Header.Set("Content-Type", "Application/JSON; charset=utf-8")
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 200 || response.Body.String() != payload {
		t.Fatalf("replayed body = %d %q", response.Code, response.Body.String())
	}
}

func TestBodyLimitsValidateParserEnvelope(t *testing.T) {
	for _, test := range []struct {
		name    string
		media   string
		body    string
		status  int
		code    string
		message string
	}{
		{"invalid_json", "application/json", "{", 400, "INVALID_REQUEST", "The request body must contain valid JSON."},
		{"empty_json", "application/json", "", 400, "INVALID_REQUEST", "The request body must contain valid JSON."},
		{"multiple_values", "application/json", "{} {}", 400, "INVALID_REQUEST", "The request body must contain valid JSON."},
		{"prototype", "application/json", `{"nested":[{"__proto__":{}}]}`, 400, "INVALID_REQUEST", "The request body must contain valid JSON."},
		{"constructor_prototype", "application/json", `{"constructor":{"prototype":{}}}`, 400, "INVALID_REQUEST", "The request body must contain valid JSON."},
		{"unsupported_media", "application/octet-stream", "raw", 415, "UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported."},
		{"json_suffix", "application/problem+json", "{}", 415, "UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported."},
		{"malformed_media", "application /json", "{}", 415, "UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported."},
		{"missing_media", "", "{}", 415, "UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported."},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := bodyApplication(t)
			called := false
			application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
				called = true
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPost, "/api/body", strings.NewReader(test.body))
			if test.media != "" {
				request.Header.Set("Content-Type", test.media)
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			bodyError(t, response, test.status, test.code, test.message)
			if called {
				t.Fatal("invalid body reached its handler")
			}
		})
	}
}

func TestBodyLimitsRejectDeclaredLengthMismatch(t *testing.T) {
	for _, declared := range []int64{1, 3} {
		application := bodyApplication(t)
		application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
			w.WriteHeader(http.StatusNoContent)
			return nil
		})
		request := httptest.NewRequest(http.MethodPost, "/api/body", strings.NewReader("{}"))
		request.Header.Set("Content-Type", "application/json")
		request.ContentLength = declared
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)
		bodyError(t, response, 400, "INVALID_REQUEST", "The request body does not match its Content-Length.")
	}
}

func TestBodyLimitsSkipBodylessMethods(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodTrace} {
		t.Run(method, func(t *testing.T) {
			application := bodyApplication(t)
			application.Handle(method+" /api/body", func(w http.ResponseWriter, r *http.Request) error {
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			body := &observedBody{reader: strings.NewReader("ignored")}
			request := httptest.NewRequest(method, "/api/body", nil)
			request.Header.Set("Content-Type", "application/octet-stream")
			request.Body, request.ContentLength = body, (1<<20)+1
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusNoContent || body.reads != 0 {
				t.Fatalf("bodyless route = %d, %d reads", response.Code, body.reads)
			}
		})
	}
}

func TestBodyLimitsPreserveStreamReadOrdering(t *testing.T) {
	application := bodyApplication(t)
	entered := false
	body := &observedBody{reader: strings.NewReader("raw stream"), entered: &entered}
	application.RegisterStream("POST /api/stream", func(w http.ResponseWriter, r *http.Request) error {
		entered = true
		_, err := io.Copy(w, r.Body)
		return err
	})
	request := httptest.NewRequest(http.MethodPost, "/api/stream", nil)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Body, request.ContentLength = body, -1
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 200 || response.Body.String() != "raw stream" || body.reads == 0 {
		t.Fatalf("stream route = %d %q, %d reads", response.Code, response.Body.String(), body.reads)
	}
}

func TestBodyLimitsPreserveMCPAuthenticationBeforeRead(t *testing.T) {
	application := bodyApplication(t)
	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			body := &observedBody{reader: strings.NewReader("not JSON")}
			request := httptest.NewRequest(method, "/mcp", nil)
			request.Header.Set("Content-Type", "application/octet-stream")
			request.Body, request.ContentLength = body, (1<<20)+1
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			bodyError(t, response, 401, "AUTH_REQUIRED", "A bearer credential is required.")
			if body.reads != 0 {
				t.Fatalf("unauthenticated MCP body was read %d times", body.reads)
			}
		})
	}
}

func TestBodyLimitsKeepUnknownRouteMediaException(t *testing.T) {
	for _, test := range []struct {
		name    string
		media   string
		body    string
		status  int
		code    string
		message string
	}{
		{"unsupported", "application/octet-stream", "raw", 404, "NOT_FOUND", "The requested API route was not found."},
		{"invalid_json", "application/json", "{", 400, "INVALID_REQUEST", "The request body must contain valid JSON."},
		{"oversize", "text/plain", strings.Repeat("x", (1<<20)+1), 413, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size."},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := bodyApplication(t)
			request := httptest.NewRequest(http.MethodPost, "/api/missing", strings.NewReader(test.body))
			request.Header.Set("Content-Type", test.media)
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			bodyError(t, response, test.status, test.code, test.message)
		})
	}
}

func TestBodyLimitsRejectMediaBeforeReading(t *testing.T) {
	application := bodyApplication(t)
	called := false
	application.Handle("POST /api/body", func(w http.ResponseWriter, r *http.Request) error {
		called = true
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	body := &observedBody{reader: strings.NewReader("not read")}
	request := httptest.NewRequest(http.MethodPost, "/api/body", nil)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Body, request.ContentLength = body, (1<<20)+1
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	bodyError(t, response, 415, "UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported.")
	if called || body.reads != 0 {
		t.Fatalf("unsupported media dispatch: handler=%v reads=%d", called, body.reads)
	}
}
