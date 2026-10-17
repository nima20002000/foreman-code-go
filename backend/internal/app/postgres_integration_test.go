//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"regexp"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/health"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
)

// These helpers exercise the public app boundary against a database allocated by
// internal/testdb. The baseline must be the controller's actual TS capture.
func postgresApplication(t *testing.T, options config.Database) (*app.App, *database.DB) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	migrationOptions := options
	migrationOptions.MaxConnections = 1
	migrationOptions.QueryTimeout = 30 * time.Minute
	migrationOptions.LockTimeout = 5 * time.Second
	migrations, err := database.OpenPool(t.Context(), migrationOptions, "graphql-migrations", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(migrations.Close)
	if err := schema.Prepare(t.Context(), migrations, "langgraph"); err != nil {
		t.Fatalf("prepare disposable database from the actual embedded TS baseline: %v", err)
	}
	db, err := database.Open(t.Context(), options, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	application, err := app.New(app.Options{
		Database: db,
		Readiness: app.Readiness{
			Database: db, Checkpoints: schema.CheckpointProbe(db, "langgraph"),
		},
		ReadinessTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	health.Register(application)
	return application, db
}

type postgresHTTP struct {
	url    string
	client *http.Client
}

type postgresHTTPResponse struct {
	status int
	body   map[string]any
}

func servePostgresApplication(t *testing.T, application *app.App) *postgresHTTP {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- application.Serve(ctx, listener) }()
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{}}
	t.Cleanup(func() {
		client.CloseIdleConnections()
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("stop PostgreSQL-backed HTTP app: %v", err)
			}
		case <-time.After(12 * time.Second):
			t.Error("PostgreSQL-backed HTTP app did not finish shutdown")
		}
	})
	return &postgresHTTP{url: "http://" + listener.Addr().String(), client: client}
}

func (server *postgresHTTP) get(t *testing.T, path string) postgresHTTPResponse {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.url+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(response.Body)
	if err := errors.Join(readErr, response.Body.Close()); err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("HTTP response content type = %q", response.Header.Get("Content-Type"))
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatalf("decode HTTP response: %v", err)
	}
	return postgresHTTPResponse{status: response.StatusCode, body: body}
}

func requirePostgresReadiness(t *testing.T, server *postgresHTTP, databaseStatus, checkpointStatus string) {
	t.Helper()
	status, statusCode := "ok", http.StatusOK
	if databaseStatus != "ok" || checkpointStatus != "ok" {
		status, statusCode = "unavailable", http.StatusServiceUnavailable
	}
	want := map[string]any{
		"status": status, "service": "graphql-api",
		"checks": map[string]any{"database": databaseStatus, "checkpoints": checkpointStatus},
	}
	deadline := time.Now().Add(5 * time.Second)
	var response postgresHTTPResponse
	for {
		response = server.get(t, "/health/ready")
		if response.status == statusCode && reflect.DeepEqual(response.body, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("readiness = %d %#v, want %d %#v", response.status, response.body, statusCode, want)
		}
		// A completed health request can still share the probe that is finishing cleanup.
		select {
		case <-time.After(20 * time.Millisecond):
		case <-t.Context().Done():
			t.Fatal(t.Context().Err())
		}
	}
}

func registerPostgresRead(application *app.App, db *database.DB, path, statement string, arguments ...any) {
	application.Handle("GET "+path, func(w http.ResponseWriter, request *http.Request) error {
		var value int
		if err := db.QueryRow(request.Context(), statement, arguments...).Scan(&value); err != nil {
			return fmt.Errorf("private database query context: %w", err)
		}
		return httpserver.WriteJSON(w, http.StatusOK, map[string]any{"value": value})
	})
}

func requirePostgresRead(t *testing.T, server *postgresHTTP) {
	t.Helper()
	response := server.get(t, "/database/value")
	want := map[string]any{"value": float64(42)}
	if response.status != http.StatusOK || !reflect.DeepEqual(response.body, want) {
		t.Fatalf("database read = %d %#v, want 200 %#v", response.status, response.body, want)
	}
}

func requirePostgresHTTPError(t *testing.T, response postgresHTTPResponse, status int, code, message string, details map[string]any) {
	t.Helper()
	failure, ok := response.body["error"].(map[string]any)
	if !ok {
		t.Fatalf("HTTP error envelope = %#v", response.body)
	}
	requestID, ok := failure["requestId"].(string)
	if !ok || !regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).MatchString(requestID) {
		t.Fatalf("HTTP error requestId = %#v, want UUID", failure["requestId"])
	}
	want := map[string]any{"code": code, "message": message, "requestId": requestID}
	if details != nil {
		want["details"] = details
	}
	// The complete public response must omit internal SQL, causes, and extra failure fields.
	if response.status != status || !reflect.DeepEqual(response.body, map[string]any{"error": want}) {
		t.Fatalf("HTTP error = %d %#v, want %d %#v", response.status, response.body, status, want)
	}
}
