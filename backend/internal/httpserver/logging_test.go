package httpserver_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

func completionLog(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var line map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&line); err != nil {
		t.Fatalf("decode request log: %v", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		t.Fatalf("expected one request log, extra = %#v, error = %v", extra, err)
	}
	return line
}

func TestRequestLoggingLevelsAndPrivateQuery(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		elapsed time.Duration
		level   string
		millis  float64
	}{
		{"success", 200, time.Millisecond, "DEBUG", 1},
		{"client_error", 404, time.Millisecond, "INFO", 1},
		{"server_error", 500, time.Millisecond, "ERROR", 1},
		{"rounded_slow", 200, 1999500 * time.Microsecond, "WARN", 2000},
		{"below_slow", 200, 1999400 * time.Microsecond, "DEBUG", 1999},
		{"slow_client_error", 404, 3 * time.Second, "WARN", 3000},
		{"slow_server_error", 503, 3 * time.Second, "ERROR", 3000},
		{"upgrade_status", 101, 0, "DEBUG", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
			start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
			calls := 0
			clock := func() time.Time {
				calls++
				if calls == 1 {
					return start
				}
				return start.Add(test.elapsed)
			}
			var requestID string
			handler := httpserver.WithRequestID(httpserver.RequestLogger{Logger: logger, Now: clock}.Wrap(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requestID = httpserver.RequestID(r.Context())
					w.WriteHeader(test.status)
				})))
			request := httptest.NewRequest(http.MethodGet, "/raw%2Fpath?code=private&token=private", nil)
			request.Header.Set("Authorization", "Bearer private")
			handler.ServeHTTP(httptest.NewRecorder(), request)
			line := completionLog(t, output.Bytes())
			for key, want := range map[string]any{"msg": "request completed", "component": "http",
				"level": test.level, "method": "GET", "path": "/raw%2Fpath", "reqId": requestID,
				"statusCode": float64(test.status), "responseTimeMs": test.millis} {
				if line[key] != want {
					t.Errorf("%s = %#v, want %#v", key, line[key], want)
				}
			}
			if requestID == "" || strings.Contains(output.String(), "private") {
				t.Fatalf("missing request identity or query data leaked: %s", output.String())
			}
		})
	}
}

type controlledResponse struct {
	header      http.Header
	statuses    []int
	readUntil   time.Time
	writeUntil  time.Time
	flushes     int
	fullDuplex  bool
	hijackError error
}

func (w *controlledResponse) Header() http.Header {
	return w.header
}
func (w *controlledResponse) WriteHeader(status int) {
	w.statuses = append(w.statuses, status)
}
func (w *controlledResponse) Write(data []byte) (int, error) {
	return len(data), nil
}
func (w *controlledResponse) FlushError() error {
	w.flushes++
	return nil
}
func (w *controlledResponse) SetReadDeadline(deadline time.Time) error {
	w.readUntil = deadline
	return nil
}
func (w *controlledResponse) SetWriteDeadline(deadline time.Time) error {
	w.writeUntil = deadline
	return nil
}
func (w *controlledResponse) EnableFullDuplex() error {
	w.fullDuplex = true
	return nil
}
func (w *controlledResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, w.hijackError
}

func TestRequestLoggingPreservesResponseController(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	hijackError := errors.New("isolated hijack result")
	destination := &controlledResponse{header: make(http.Header), hijackError: hijackError}
	deadline := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	handler := httpserver.RequestLogger{Logger: logger}.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		controller := http.NewResponseController(w)
		if err := controller.SetReadDeadline(deadline); err != nil {
			t.Error(err)
		}
		if err := controller.SetWriteDeadline(deadline); err != nil {
			t.Error(err)
		}
		if err := controller.EnableFullDuplex(); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusSwitchingProtocols)
		if err := controller.Flush(); err != nil {
			t.Error(err)
		}
		if _, _, err := controller.Hijack(); !errors.Is(err, hijackError) {
			t.Errorf("Hijack = %v, want unchanged result", err)
		}
	}))
	handler.ServeHTTP(destination, httptest.NewRequest(http.MethodGet, "/stream", nil))
	if !destination.readUntil.Equal(deadline) || !destination.writeUntil.Equal(deadline) ||
		!destination.fullDuplex || destination.flushes != 1 {
		t.Fatalf("response controls did not reach their destination: %#v", destination)
	}
	if completionLog(t, output.Bytes())["statusCode"] != float64(101) {
		t.Fatal("upgrade status was lost")
	}
}

func TestRequestLoggingTracksFinalAndFlushedStatus(t *testing.T) {
	for _, test := range []struct {
		name  string
		flush bool
		want  float64
	}{
		{"informational_then_final", false, 206},
		{"flush_commits_success", true, 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
			destination := &controlledResponse{header: make(http.Header)}
			handler := httpserver.RequestLogger{Logger: logger}.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusEarlyHints)
				if test.flush {
					if err := http.NewResponseController(w).Flush(); err != nil {
						t.Fatal(err)
					}
				}
				w.WriteHeader(http.StatusPartialContent)
				w.WriteHeader(http.StatusInternalServerError)
			}))
			handler.ServeHTTP(destination, httptest.NewRequest(http.MethodGet, "/asset", nil))
			if got := completionLog(t, output.Bytes())["statusCode"]; got != test.want {
				t.Fatalf("logged status = %v, want %v", got, test.want)
			}
		})
	}
}

func TestRequestLoggingPropagatesAbortWithoutCompletion(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	handler := httpserver.RequestLogger{Logger: logger}.Wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	func() {
		defer func() {
			if value := recover(); value != http.ErrAbortHandler {
				t.Errorf("panic = %#v, want unchanged ErrAbortHandler", value)
			}
		}()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/stream", nil))
		t.Error("abort was swallowed")
	}()
	if output.Len() != 0 {
		t.Fatalf("aborted request emitted a completion: %s", output.String())
	}
}

func TestRequestLoggingAppComposition(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	application, err := app.New(app.Options{Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	application.Handle("GET /failure", func(http.ResponseWriter, *http.Request) error {
		return domainerror.New("FORBIDDEN", "Access denied.", http.StatusForbidden, nil)
	})
	application.RegisterStream("GET /events", func(w http.ResponseWriter, _ *http.Request) error {
		w.Header().Set("Content-Type", "text/event-stream")
		if _, err := io.WriteString(w, "data: ready\n\n"); err != nil {
			return err
		}
		return http.NewResponseController(w).Flush()
	})
	for _, target := range []string{"/failure?token=private", "/events?token=private"} {
		output.Reset()
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		line := completionLog(t, output.Bytes())
		if line["reqId"] == "" || strings.Contains(output.String(), "private") || line["statusCode"] != float64(response.Code) {
			t.Fatalf("composed request log = %#v, status = %d", line, response.Code)
		}
		if strings.HasPrefix(target, "/failure") {
			var envelope struct {
				Error struct {
					RequestID string `json:"requestId"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.RequestID != line["reqId"] {
				t.Fatalf("error/log identity mismatch: %s, %v", response.Body.Bytes(), err)
			}
		} else if response.Body.String() != "data: ready\n\n" || response.Header().Get("Content-Type") != "text/event-stream" || !response.Flushed {
			t.Fatalf("stream behavior changed: %#v", response)
		}
	}
}
