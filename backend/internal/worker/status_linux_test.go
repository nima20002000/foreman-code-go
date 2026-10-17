package worker_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/worker"
)

func statusPeer(t *testing.T, state string, reply func(context.Context, net.Conn)) {
	t.Helper()
	canonical, err := filepath.EvalSymlinks(state)
	if err != nil {
		t.Fatal(err)
	}
	// This fixture implements the frozen worker's observable status protocol;
	// it does not read repository source or use the Go implementation's helpers.
	digest := sha256.Sum256([]byte(canonical))
	listener, err := net.ListenUnix("unix", &net.UnixAddr{
		Name: "@graphql-worker-" + hex.EncodeToString(digest[:]), Net: "unix",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		defer connection.Close()
		reply(ctx, connection)
	}()
	t.Cleanup(func() {
		cancel()
		_ = listener.Close()
		<-done
	})
}

func TestWorkerStatusRenewsIdleTimeoutOnEachChunk(t *testing.T) {
	state := t.TempDir()
	statusPeer(t, state, func(ctx context.Context, connection net.Conn) {
		for index, chunk := range []string{`{"`, `ac`, `tive`, `":`, `tr`, `ue}`} {
			if index != 0 {
				timer := time.NewTimer(250 * time.Millisecond)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			if _, err := connection.Write([]byte(chunk)); err != nil {
				// ignore: a rejected reader can close before this peer completes.
				return
			}
		}
	})
	status, err := worker.ReadWorkerStatus(context.Background(), state)
	if err != nil || string(status) != `{"active":true}` {
		t.Fatalf("continuously active status peer=%s error=%v", status, err)
	}
}

func TestWorkerStatusTimesOutAnInactivePeer(t *testing.T) {
	state := t.TempDir()
	statusPeer(t, state, func(ctx context.Context, _ net.Conn) { <-ctx.Done() })
	_, err := worker.ReadWorkerStatus(context.Background(), state)
	requireWorkerError(t, err, "worker_status_timeout")
}

func TestWorkerStatusCancelsAnActiveRead(t *testing.T) {
	state := t.TempDir()
	connected := make(chan struct{})
	statusPeer(t, state, func(ctx context.Context, _ net.Conn) {
		close(connected)
		<-ctx.Done()
	})
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	result := make(chan error, 1)
	go func() {
		_, err := worker.ReadWorkerStatus(ctx, state)
		result <- err
	}()
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("status reader did not connect")
	}
	cause := errors.New("status reader no longer needed")
	cancel(cause)
	select {
	case err := <-result:
		if !errors.Is(err, cause) {
			t.Fatalf("read cancellation=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled status reader did not finish")
	}
}
