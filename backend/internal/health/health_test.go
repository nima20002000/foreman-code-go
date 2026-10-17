package health_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/health"
)

type pingFunc func(context.Context) error

func (f pingFunc) Ping(ctx context.Context) error { return f(ctx) }

func newHealth(t *testing.T, readiness app.Readiness, timeout time.Duration) *app.App {
	t.Helper()
	application, err := app.New(app.Options{Readiness: readiness, ReadinessTimeout: timeout})
	if err != nil {
		t.Fatal(err)
	}
	health.Register(application)
	return application
}

func probe(t *testing.T, application *app.App, path string) (int, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil)
	application.Handler().ServeHTTP(recorder, request)
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return recorder.Code, body
}

func TestLivenessDoesNotConsultInfrastructure(t *testing.T) {
	var calls atomic.Int32
	check := pingFunc(func(context.Context) error {
		calls.Add(1)
		return errors.New("offline")
	})
	application := newHealth(t, app.Readiness{Database: check, Checkpoints: check}, 0)
	status, body := probe(t, application, "/health/live")
	want := map[string]any{"status": "ok", "service": "graphql-api"}
	if status != 200 || !reflect.DeepEqual(body, want) {
		t.Fatalf("liveness = %d %#v, want 200 %#v", status, body, want)
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("liveness consulted infrastructure %d times", got)
	}
}

func TestReadinessReportsEachDependency(t *testing.T) {
	for _, test := range []struct {
		name       string
		database   error
		checkpoint error
		status     int
	}{
		{name: "available", status: 200},
		{name: "database unavailable", database: errors.New("offline"), status: 503},
		{name: "checkpoints unavailable", checkpoint: errors.New("offline"), status: 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := newHealth(t, app.Readiness{
				Database: pingFunc(func(context.Context) error { return test.database }),
				Checkpoints: pingFunc(func(context.Context) error { return test.checkpoint }),
			}, 0)
			status, body := probe(t, application, "/health/ready")
			want := map[string]any{
				"status": "ok", "service": "graphql-api",
				"checks": map[string]any{"database": "ok", "checkpoints": "ok"},
			}
			if test.database != nil {
				want["checks"].(map[string]any)["database"] = "unavailable"
				want["status"] = "unavailable"
			}
			if test.checkpoint != nil {
				want["checks"].(map[string]any)["checkpoints"] = "unavailable"
				want["status"] = "unavailable"
			}
			if status != test.status || !reflect.DeepEqual(body, want) {
				t.Fatalf("readiness = %d %#v, want %d %#v", status, body, test.status, want)
			}
		})
	}
}

func TestReadinessBoundsAndSharesUncooperativeChecks(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	defer close(release)
	application := newHealth(t, app.Readiness{
		Database: pingFunc(func(context.Context) error {
			calls.Add(1)
			<-release
			return nil
		}),
		Checkpoints: pingFunc(func(context.Context) error { return nil }),
	}, 20*time.Millisecond)
	done := make(chan int, 1)
	go func() {
		recorder := httptest.NewRecorder()
		application.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
		done <- recorder.Code
	}()
	select {
	case status := <-done:
		if status != 503 {
			t.Fatalf("timed-out readiness = %d, want 503", status)
		}
	case <-time.After(time.Second):
		t.Fatal("readiness did not honor its deadline")
	}
	for range 5 {
		status, _ := probe(t, application, "/health/ready")
		if status != 503 {
			t.Fatalf("pending dependency readiness = %d, want 503", status)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("uncooperative dependency queued %d checks, want one", got)
	}
}

func TestReadinessTimeoutMustBePositiveIntegerMilliseconds(t *testing.T) {
	for _, timeout := range []time.Duration{-time.Millisecond, 1500 * time.Microsecond, 2147483648 * time.Millisecond} {
		if _, err := app.New(app.Options{ReadinessTimeout: timeout}); err == nil {
			t.Fatalf("invalid readiness timeout %s accepted", timeout)
		}
	}
}

func TestReadinessDoesNotReportSuccessAfterTheDeadline(t *testing.T) {
	lateSuccess := pingFunc(func(ctx context.Context) error {
		<-ctx.Done()
		return nil
	})
	application := newHealth(t, app.Readiness{
		Database: lateSuccess,
		Checkpoints: pingFunc(func(context.Context) error { return nil }),
	}, 2*time.Millisecond)
	for range 8 {
		status, body := probe(t, application, "/health/ready")
		if status != 503 || body["checks"].(map[string]any)["database"] != "unavailable" {
			t.Fatalf("expired dependency reported healthy: %d %#v", status, body)
		}
	}
}
