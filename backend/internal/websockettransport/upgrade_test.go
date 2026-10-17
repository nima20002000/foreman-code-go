package websockettransport_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/websockettransport"
)

func allowRequest(request *http.Request) (context.Context, error) {
	return request.Context(), nil
}

func websocketApp(t *testing.T, options websockettransport.Options, logger *slog.Logger) *app.App {
	t.Helper()
	handler, err := websockettransport.New(options)
	if err != nil {
		t.Fatal(err)
	}
	application, err := app.New(app.Options{Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	application.RegisterStream("/socket", handler)
	return application
}

func TestWebSocketRejectsInvalidOptions(t *testing.T) {
	valid := websockettransport.Options{
		Authorize: allowRequest,
		Serve: func(context.Context, *websocket.Conn) error { return nil },
		ReadLimit: 16_384,
	}
	for _, test := range []struct {
		name string
		change func(*websockettransport.Options)
	}{
		{"missing_authorize", func(options *websockettransport.Options) { options.Authorize = nil }},
		{"missing_serve", func(options *websockettransport.Options) { options.Serve = nil }},
		{"zero_limit", func(options *websockettransport.Options) { options.ReadLimit = 0 }},
		{"negative_limit", func(options *websockettransport.Options) { options.ReadLimit = -1 }},
		{"overflow_limit", func(options *websockettransport.Options) { options.ReadLimit = math.MaxInt64 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			options := valid
			test.change(&options)
			if handler, err := websockettransport.New(options); err == nil || handler != nil {
				t.Fatalf("invalid options returned handler=%v error=%v", handler != nil, err)
			}
		})
	}
}

func TestWebSocketRejectsExtensionsBeforeAuthentication(t *testing.T) {
	for _, test := range []struct { name, headers string }{
		{"offer", "Sec-WebSocket-Extensions: permessage-deflate\r\n"},
		{"duplicate_offer", "Sec-WebSocket-Extensions:\r\nSec-WebSocket-Extensions: permessage-deflate\r\n"},
		{"duplicate_empty", "Sec-WebSocket-Extensions:\r\nSec-WebSocket-Extensions:\r\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var authenticated, served atomic.Int32
			application := websocketApp(t, websockettransport.Options{
				Authorize: func(request *http.Request) (context.Context, error) {
					authenticated.Add(1)
					return request.Context(), nil
				},
				Serve: func(context.Context, *websocket.Conn) error { served.Add(1); return nil },
				ReadLimit: 16_384,
			}, nil)
			server := httptest.NewServer(application.Handler())
			defer server.Close()
			connection := rawUpgrade(t, server, test.headers)
			defer connection.Close()
			data, err := io.ReadAll(connection)
			if err != nil {
				t.Fatalf("read aborted response: %v", err)
			}
			if len(data) != 0 || authenticated.Load() != 0 || served.Load() != 0 {
				t.Fatalf("extension abort returned %q, auth=%d serve=%d", data, authenticated.Load(), served.Load())
			}
		})
	}
}

func TestWebSocketAuthenticatesBeforeHandshakeValidation(t *testing.T) {
	var calls, served atomic.Int32
	application := websocketApp(t, websockettransport.Options{
		Authorize: func(*http.Request) (context.Context, error) {
			calls.Add(1)
			return nil, domainerror.New("AUTH_REQUIRED", "A bearer credential is required.", 401, nil)
		},
		Serve: func(context.Context, *websocket.Conn) error { served.Add(1); return nil },
		ReadLimit: 16_384,
	}, nil)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/socket", nil)
	recorder := httptest.NewRecorder()
	application.Handler().ServeHTTP(recorder, request)
	if recorder.Code != 401 || calls.Load() != 1 || served.Load() != 0 || recorder.Header().Get("Upgrade") != "" {
		t.Fatalf("authorization boundary status=%d auth=%d serve=%d headers=%v", recorder.Code, calls.Load(), served.Load(), recorder.Header())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"AUTH_REQUIRED"`) {
		t.Fatalf("authorization error was lost: %s", recorder.Body.String())
	}
}

func TestWebSocketRejectsMissingOrCancelledAuthorizedContext(t *testing.T) {
	for _, name := range []string{"nil", "cancelled", "request_cancelled"} {
		t.Run(name, func(t *testing.T) {
			var served atomic.Int32
			application := websocketApp(t, websockettransport.Options{
				Authorize: func(request *http.Request) (context.Context, error) {
					if name == "nil" { return nil, nil }
					if name == "request_cancelled" { return context.Background(), nil }
					ctx, cancel := context.WithCancel(request.Context())
					cancel()
					return ctx, nil
				},
				Serve: func(context.Context, *websocket.Conn) error { served.Add(1); return nil },
				ReadLimit: 16_384,
			}, nil)
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/socket", nil)
			if name == "request_cancelled" {
				ctx, cancel := context.WithCancel(request.Context())
				cancel()
				request = request.WithContext(ctx)
			}
			recorder := httptest.NewRecorder()
			application.Handler().ServeHTTP(recorder, request)
			if recorder.Code != 500 || served.Load() != 0 || recorder.Header().Get("Upgrade") != "" {
				t.Fatalf("invalid context status=%d serve=%d headers=%v", recorder.Code, served.Load(), recorder.Header())
			}
		})
	}
}

type authorizedKey struct{}

func TestWebSocketUsesAuthenticatedContextAndSourceOriginPolicy(t *testing.T) {
	var authenticated atomic.Int32
	completed := make(chan error, 2)
	application := websocketApp(t, websockettransport.Options{
		Authorize: func(request *http.Request) (context.Context, error) {
			if request.Header.Get("Authorization") != "Bearer isolated-fixture" || request.Header.Get("Origin") != "https://source-policy.example" {
				return nil, domainerror.New("ACCESS_DENIED", "Fixture access denied.", 403, nil)
			}
			return context.WithValue(request.Context(), authorizedKey{}, authenticated.Add(1)), nil
		},
		Serve: func(ctx context.Context, connection *websocket.Conn) error {
			value, ok := ctx.Value(authorizedKey{}).(int32)
			if !ok { return errors.New("authenticated context was lost") }
			err := connection.Write(ctx, websocket.MessageText, []byte("authorized-"+strconv.Itoa(int(value))))
			if err == nil { _, _, err = connection.Read(ctx) }
			completed <- err
			return err
		},
		ReadLimit: 64,
	}, nil)
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	for attempt := 1; attempt <= 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/socket", &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": {"Bearer isolated-fixture"}, "Origin": {"https://source-policy.example"}},
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil { cancel(); t.Fatal(err) }
		if response.Header.Get("Sec-WebSocket-Extensions") != "" {
			connection.CloseNow(); cancel(); t.Fatal("compression was negotiated")
		}
		kind, data, err := connection.Read(ctx)
		if err != nil || kind != websocket.MessageText || string(data) != "authorized-"+strconv.Itoa(attempt) {
			connection.CloseNow(); cancel(); t.Fatalf("authenticated readback=%q kind=%v error=%v", data, kind, err)
		}
		if err := connection.Write(ctx, websocket.MessageText, []byte("done")); err != nil {
			connection.CloseNow(); cancel(); t.Fatal(err)
		}
		select {
		case err := <-completed:
			if err != nil { t.Error(err) }
		case <-ctx.Done():
			t.Error("connection handler did not complete")
		}
		connection.CloseNow()
		cancel()
	}
	if authenticated.Load() != 2 { t.Fatalf("authenticated %d upgrades, want 2", authenticated.Load()) }
}

func TestWebSocketEnforcesSuppliedReadLimit(t *testing.T) {
	for _, test := range []struct { name string; parts []string; accepted bool }{
		{"at_limit", []string{"12345678"}, true},
		{"above_limit", []string{"123456789"}, false},
		{"fragmented_above_limit", []string{"12345", "6789"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			readResult := make(chan error, 1)
			application := websocketApp(t, websockettransport.Options{
				Authorize: allowRequest,
				Serve: func(ctx context.Context, connection *websocket.Conn) error {
					kind, data, err := connection.Read(ctx)
					if err == nil { err = connection.Write(ctx, kind, data) }
					readResult <- err
					return err
				},
				ReadLimit: 8,
			}, nil)
			server := httptest.NewServer(application.Handler())
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/socket", nil)
			if err != nil { t.Fatal(err) }
			defer connection.CloseNow()
			writer, err := connection.Writer(ctx, websocket.MessageText)
			if err != nil { t.Fatal(err) }
			for _, part := range test.parts {
				if _, err := io.WriteString(writer, part); err != nil { t.Fatal(err) }
			}
			if err := writer.Close(); err != nil { t.Fatal(err) }
			_, data, err := connection.Read(ctx)
			if test.accepted {
				if err != nil || string(data) != strings.Join(test.parts, "") { t.Fatalf("limit readback=%q error=%v", data, err) }
			} else if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
				t.Fatalf("oversized message returned %q error=%v", data, err)
			}
			select {
			case err := <-readResult:
				if test.accepted && err != nil { t.Fatal(err) }
				if !test.accepted && err == nil { t.Fatal("oversized message reached successful handler read") }
			case <-ctx.Done():
				t.Fatal("server read did not complete")
			}
		})
	}
}

func TestWebSocketAppRetainsServeFailureAfterUpgrade(t *testing.T) {
	logs := &observedLog{changed: make(chan struct{}, 1)}
	failure := errors.New("isolated WebSocket serve failure")
	application := websocketApp(t, websockettransport.Options{
		Authorize: allowRequest,
		Serve: func(context.Context, *websocket.Conn) error { return failure },
		ReadLimit: 16_384,
	}, slog.New(slog.NewJSONHandler(logs, nil)))
	server := httptest.NewServer(application.Handler())
	defer server.Close()
	connection := rawUpgrade(t, server, "")
	defer connection.Close()
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil { t.Fatal(err) }
	defer response.Body.Close()
	if response.StatusCode != 101 { t.Fatalf("upgrade status=%d", response.StatusCode) }
	remaining, err := io.ReadAll(reader)
	if err != nil { t.Fatal(err) }
	if len(remaining) != 0 { t.Fatalf("HTTP bytes appended after upgrade: %q", remaining) }
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for !strings.Contains(logs.String(), failure.Error()) {
		select {
		case <-logs.changed:
		case <-deadline.C:
			t.Fatalf("post-upgrade failure was lost: %s", logs.String())
		}
	}
}

func rawUpgrade(t *testing.T, server *httptest.Server, headers string) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 2*time.Second)
	if err != nil { t.Fatal(err) }
	if err := connection.SetDeadline(time.Now().Add(2 * time.Second)); err != nil { connection.Close(); t.Fatal(err) }
	request := "GET /socket HTTP/1.1\r\nHost: " + server.Listener.Addr().String() + "\r\n" +
		"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" + headers + "\r\n"
	if _, err := fmt.Fprint(connection, request); err != nil { connection.Close(); t.Fatal(err) }
	return connection
}

type observedLog struct {
	mu sync.Mutex
	data bytes.Buffer
	changed chan struct{}
}

func (log *observedLog) Write(data []byte) (int, error) {
	log.mu.Lock()
	n, err := log.data.Write(data)
	log.mu.Unlock()
	select { case log.changed <- struct{}{}: default: }
	return n, err
}

func (log *observedLog) String() string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return log.data.String()
}
