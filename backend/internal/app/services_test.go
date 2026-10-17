package app_test

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/health"
)

type pingFunc func(context.Context) error

func (p pingFunc) Ping(ctx context.Context) error { return p(ctx) }

func TestAppShutdownDrainsRequestsBeforeStoppingBackgroundServices(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	entered, release := make(chan struct{}), make(chan struct{})
	releaseCheck := sync.OnceFunc(func() { close(release) })
	defer releaseCheck()
	stopped := make(chan struct{})
	application, err := app.New(app.Options{Readiness: app.Readiness{
		Database: pingFunc(func(context.Context) error {
			close(entered)
			<-release
			return nil
		}),
		Checkpoints: pingFunc(func(context.Context) error { return nil }),
	}})
	if err != nil {
		t.Fatal(err)
	}
	health.Register(application)
	application.RegisterService("observations", func(ctx context.Context) error {
		<-ctx.Done()
		close(stopped)
		return ctx.Err()
	})
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
	defer cancel()
	serverDone := make(chan error, 1)
	go func() { serverDone <- application.Serve(ctx, listener) }()
	response := make(chan int, 1)
	requestErrors := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: time.Second}
		result, err := client.Get("http://" + listener.Addr().String() + "/health/ready")
		if err != nil {
			requestErrors <- err
			return
		}
		_, readErr := io.Copy(io.Discard, result.Body)
		if err := errors.Join(readErr, result.Body.Close()); err != nil {
			requestErrors <- err
			return
		}
		response <- result.StatusCode
	}()
	select {
	case <-entered:
	case err := <-requestErrors:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("readiness request did not start")
	}
	cancel()
	select {
	case <-stopped:
		t.Error("background work stopped before the in-flight request drained")
	default:
	}
	releaseCheck()
	select {
	case status := <-response:
		if status != http.StatusOK {
			t.Fatalf("drained request status = %d", status)
		}
	case err := <-requestErrors:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("readiness request did not drain")
	}
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not finish shutdown")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("registered background work did not stop")
	}
}

func TestBackgroundServiceFailureStopsAndReportsTheApp(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "domain failure", err: errors.New("observation failed")},
		{name: "independent cancellation", err: context.Canceled},
		{name: "independent server-closed error", err: http.ErrServerClosed},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			application, err := app.New(app.Options{})
			if err != nil {
				t.Fatal(err)
			}
			application.RegisterService("observations", func(context.Context) error { return test.err })
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
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- application.Serve(ctx, listener) }()
			select {
			case err := <-done:
				if !errors.Is(err, test.err) {
					t.Fatalf("service error = %v, want wrapped %v", err, test.err)
				}
			case <-time.After(time.Second):
				t.Fatal("app did not stop after its background service failed")
			}
		})
	}
}

func TestServiceFailureJoinedWithShutdownCancellationRemainsVisible(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	application, err := app.New(app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	want := errors.New("observation cleanup failed")
	application.RegisterService("observations", func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return errors.Join(ctx.Err(), want)
	})
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
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- application.Serve(ctx, listener) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("background service did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, want) {
			t.Fatalf("shutdown discarded independent joined failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("app did not complete shutdown")
	}
}

type failingListener struct {
	net.Listener
	failure error
}

func (l failingListener) Accept() (net.Conn, error) { return nil, l.failure }

func TestHTTPServerClosedJoinRetainsIndependentFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	application, err := app.New(app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	want := errors.New("listener failed independently")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- application.Serve(ctx, failingListener{Listener: listener, failure: errors.Join(http.ErrServerClosed, want)})
	}()
	select {
	case err := <-done:
		if !errors.Is(err, want) {
			t.Fatalf("HTTP shutdown discarded independent joined failure: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("app did not report listener failure")
	}
}
