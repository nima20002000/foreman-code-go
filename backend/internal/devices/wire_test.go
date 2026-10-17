package devices_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

type wireInput struct {
	text   string
	binary bool
	err    error
}

type controlledWireSocket struct {
	input        chan wireInput
	readStarted  chan struct{}
	writeStarted chan string
	closeStarted chan struct{}
	closed       chan struct{}
	closeOnce    sync.Once
	closeCount   atomic.Int32
	readCount    atomic.Int32
	writeCount   atomic.Int32
	writeOverlap atomic.Bool
	write        func(context.Context, string) error
	close        func() error
}

func newControlledWireSocket() *controlledWireSocket {
	return &controlledWireSocket{
		input: make(chan wireInput), readStarted: make(chan struct{}, 64),
		writeStarted: make(chan string, 64), closeStarted: make(chan struct{}), closed: make(chan struct{}),
	}
}

func (socket *controlledWireSocket) Read(ctx context.Context) (string, bool, error) {
	socket.readCount.Add(1)
	select {
	case socket.readStarted <- struct{}{}:
	case <-ctx.Done():
		return "", false, ctx.Err()
	}
	select {
	case input := <-socket.input:
		return input.text, input.binary, input.err
	case <-ctx.Done():
		return "", false, ctx.Err()
	case <-socket.closed:
		return "", false, io.EOF
	}
}

func (socket *controlledWireSocket) Write(ctx context.Context, text string) error {
	if socket.writeCount.Add(1) != 1 {
		socket.writeOverlap.Store(true)
	}
	defer socket.writeCount.Add(-1)
	socket.writeStarted <- text
	if socket.write != nil {
		return socket.write(ctx, text)
	}
	return nil
}

func (socket *controlledWireSocket) Close() error {
	socket.closeCount.Add(1)
	socket.closeOnce.Do(func() { close(socket.closeStarted) })
	var err error
	if socket.close != nil {
		err = socket.close()
	}
	close(socket.closed)
	return err
}

func wireFixture(t *testing.T, options devices.WireOptions,
	configure func(*controlledWireSocket)) (*devices.DeviceWire, *controlledWireSocket) {
	t.Helper()
	socket := newControlledWireSocket()
	if configure != nil {
		configure(socket)
	}
	wire, err := devices.NewDeviceWire(context.Background(), socket, options)
	if err != nil {
		t.Fatalf("create bounded device wire: %v", err)
	}
	t.Cleanup(func() {
		wire.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		wire.Join(ctx)
		if ctx.Err() != nil {
			t.Error("device wire did not finish physical cleanup")
		}
	})
	awaitWireSignal(t, socket.readStarted)
	return wire, socket
}

func smallWireOptions() devices.WireOptions {
	return devices.WireOptions{Limits: devices.WireLimits{FrameBytes: 8, BufferBytes: 16, QueueDepth: 2}}
}

func sendWireInput(t *testing.T, socket *controlledWireSocket, input wireInput) {
	t.Helper()
	select {
	case socket.input <- input:
	case <-time.After(3 * time.Second):
		t.Fatal("physical device reader did not accept its next input")
	}
}

func queueWireFrame(t *testing.T, socket *controlledWireSocket, text string) {
	t.Helper()
	sendWireInput(t, socket, wireInput{text: text})
	// Starting the next physical read proves the previous frame has settled.
	awaitWireSignal(t, socket.readStarted)
}

func awaitWireSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("device wire did not reach its carrier synchronization point")
	}
}

func awaitWireResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("device wire operation did not settle")
		return nil
	}
}

func awaitWireText(t *testing.T, result <-chan string) string {
	t.Helper()
	select {
	case text := <-result:
		return text
	case <-time.After(3 * time.Second):
		t.Fatal("device wire did not deliver text")
		return ""
	}
}

func requireWireFrame(t *testing.T, wire *devices.DeviceWire, want string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	text, err := wire.Next(ctx)
	if err != nil || text != want {
		t.Fatalf("opaque frame = %q, %v; want %q", text, err, want)
	}
}

func joinWire(t *testing.T, wire *devices.DeviceWire) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return wire.Join(ctx)
}

func wireGate() (<-chan struct{}, func()) {
	gate := make(chan struct{})
	var once sync.Once
	return gate, func() { once.Do(func() { close(gate) }) }
}

// The context reports when its caller begins waiting, without exposing wire
// state. This makes cancellation of a queued send distinct from cancellation
// before Send was called.
type wireWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (ctx *wireWaitContext) Done() <-chan struct{} {
	ctx.once.Do(func() { close(ctx.waiting) })
	return ctx.Context.Done()
}

func TestDeviceWirePreservesOpaqueTextAndExactFrameLimit(t *testing.T) {
	// These are the frozen deviceConnection.ts public limits, supplied by the
	// test adapter. Production obtains them from I's generated contract export.
	options := devices.WireOptions{Limits: devices.WireLimits{FrameBytes: 16_384, BufferBytes: 65_536, QueueDepth: 32}}
	wire, socket := wireFixture(t, options, nil)
	text := strings.Repeat("é", 8_192)
	queueWireFrame(t, socket, text)
	requireWireFrame(t, wire, text)
	queueWireFrame(t, socket, "")
	requireWireFrame(t, wire, "")
	if err := wire.Send(context.Background(), text); err != nil || awaitWireText(t, socket.writeStarted) != text {
		t.Fatalf("exact byte-limit send failed: %v", err)
	}
	if err := wire.Send(context.Background(), text+"x"); !errors.Is(err, devices.ErrWireBackpressure) {
		t.Fatalf("oversized send = %v, want backpressure", err)
	}
	if err := wire.Send(context.Background(), "opaque"); err != nil || awaitWireText(t, socket.writeStarted) != "opaque" {
		t.Fatalf("rejected send closed the carrier: %v", err)
	}
}

func TestDeviceWireIngressBoundsFailClosedAndDiscardUnreadFrames(t *testing.T) {
	tests := []struct {
		name    string
		options devices.WireOptions
		queued  []string
		input   wireInput
		failure error
	}{
		{"binary", smallWireOptions(), []string{"before"}, wireInput{text: "data", binary: true}, devices.ErrWireMalformedFrame},
		{"frame-bytes", smallWireOptions(), []string{"before"}, wireInput{text: "123456789"}, devices.ErrWireBackpressure},
		{"queue-depth", smallWireOptions(), []string{"one", "two"}, wireInput{text: "three"}, devices.ErrWireBackpressure},
		{"queue-bytes", devices.WireOptions{Limits: devices.WireLimits{FrameBytes: 4, BufferBytes: 6, QueueDepth: 8}},
			[]string{"abc", "def"}, wireInput{text: "g"}, devices.ErrWireBackpressure},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			wire, socket := wireFixture(t, test.options, nil)
			for _, text := range test.queued {
				queueWireFrame(t, socket, text)
			}
			sendWireInput(t, socket, test.input)
			awaitWireSignal(t, socket.closeStarted)
			if text, err := wire.Next(context.Background()); text != "" || !errors.Is(err, test.failure) {
				t.Fatalf("failed ingress returned stale frame %q, %v; want %v", text, err, test.failure)
			}
			if err := joinWire(t, wire); !errors.Is(err, test.failure) || socket.closeCount.Load() != 1 {
				t.Fatalf("failed ingress cleanup = %v, %d closes", err, socket.closeCount.Load())
			}
		})
	}
}

func TestDeviceWireReadingReleasesUnreadByteAndDepthBudgets(t *testing.T) {
	options := devices.WireOptions{Limits: devices.WireLimits{FrameBytes: 4, BufferBytes: 6, QueueDepth: 2}}
	wire, socket := wireFixture(t, options, nil)
	queueWireFrame(t, socket, "abc")
	queueWireFrame(t, socket, "def")
	requireWireFrame(t, wire, "abc")
	queueWireFrame(t, socket, "ghi")
	requireWireFrame(t, wire, "def")
	requireWireFrame(t, wire, "ghi")
}

func TestDeviceWireWaitCancellationKeepsLaterFramesAvailable(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if _, err := wire.Next(ctx); !errors.Is(err, devices.ErrWireTimeout) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline wait = %v, want timeout with deadline cause", err)
	}
	canceled, cancelWait := context.WithCancel(context.Background())
	cancelWait()
	if _, err := wire.Next(canceled); !errors.Is(err, devices.ErrWireTransport) || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled wait = %v, want transport with cancellation cause", err)
	}
	queueWireFrame(t, socket, "later")
	requireWireFrame(t, wire, "later")
	if socket.closeCount.Load() != 0 {
		t.Fatal("an expired individual wait closed the carrier")
	}
}

func TestDeviceWireRetainsAdapterTerminalReasonAcrossPeerClose(t *testing.T) {
	terminal := errors.New("revoked")
	blocked := `{"type":"blocked","code":"revoked"}`
	options := devices.WireOptions{
		Limits: devices.WireLimits{FrameBytes: 128, BufferBytes: 256, QueueDepth: 2},
		TerminalFailure: func(text string) error {
			if text == blocked {
				return terminal
			}
			return nil
		},
	}
	wire, socket := wireFixture(t, options, nil)
	queueWireFrame(t, socket, blocked)
	sendWireInput(t, socket, wireInput{err: io.EOF})
	awaitWireSignal(t, socket.closeStarted)
	if text, err := wire.Next(context.Background()); text != "" || !errors.Is(err, terminal) {
		t.Fatalf("closed blocked frame = %q, %v; want retained terminal reason", text, err)
	}
	if err := joinWire(t, wire); !errors.Is(err, terminal) {
		t.Fatalf("terminal drain = %v, want retained reason", err)
	}
}

func TestDeviceWireNormalPeerCloseDiscardsUnreadFrames(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	queueWireFrame(t, socket, "unread")
	sendWireInput(t, socket, wireInput{err: io.EOF})
	awaitWireSignal(t, socket.closeStarted)
	if text, err := wire.Next(context.Background()); text != "" || !errors.Is(err, io.EOF) {
		t.Fatalf("normal close returned %q, %v; want end of stream", text, err)
	}
	if err := joinWire(t, wire); err != nil {
		t.Fatalf("normal carrier close failed: %v", err)
	}
}

func TestDeviceWireReportsReadAndPhysicalCloseFailures(t *testing.T) {
	readFailure := errors.New("carrier read failed")
	closeFailure := errors.New("carrier close failed")
	wire, socket := wireFixture(t, smallWireOptions(), func(socket *controlledWireSocket) {
		socket.close = func() error { return closeFailure }
	})
	sendWireInput(t, socket, wireInput{err: readFailure})
	awaitWireSignal(t, socket.closeStarted)
	if _, err := wire.Next(context.Background()); !errors.Is(err, devices.ErrWireTransport) || !errors.Is(err, readFailure) {
		t.Fatalf("read failure = %v, want transport and original cause", err)
	}
	if err := joinWire(t, wire); !errors.Is(err, readFailure) || !errors.Is(err, closeFailure) {
		t.Fatalf("physical drain lost a failure: %v", err)
	}
}

func TestDeviceWireSendBudgetAndCanceledQueueReservation(t *testing.T) {
	gate, release := wireGate()
	defer release()
	options := devices.WireOptions{Limits: devices.WireLimits{FrameBytes: 4, BufferBytes: 4, QueueDepth: 2}}
	wire, socket := wireFixture(t, options, func(socket *controlledWireSocket) {
		socket.write = func(ctx context.Context, text string) error {
			if text == "aa" {
				select {
				case <-gate:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		}
	})
	first := make(chan error, 1)
	go func() { first <- wire.Send(context.Background(), "aa") }()
	if got := awaitWireText(t, socket.writeStarted); got != "aa" {
		t.Fatalf("first physical send = %q", got)
	}
	if err := wire.Send(context.Background(), "bbb"); !errors.Is(err, devices.ErrWireBackpressure) {
		t.Fatalf("send over pending byte budget = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waiter := &wireWaitContext{Context: ctx, waiting: make(chan struct{})}
	queued := make(chan error, 1)
	go func() { queued <- wire.Send(waiter, "cc") }()
	awaitWireSignal(t, waiter.waiting)
	if err := wire.Send(context.Background(), "x"); !errors.Is(err, devices.ErrWireBackpressure) {
		t.Fatalf("waiting send did not reserve its bytes: %v", err)
	}
	cancel()
	if err := awaitWireResult(t, queued); !errors.Is(err, devices.ErrWireTransport) || !errors.Is(err, context.Canceled) {
		t.Fatalf("queued send did not cancel: %v", err)
	}
	release()
	if err := awaitWireResult(t, first); err != nil {
		t.Fatalf("first physical send failed: %v", err)
	}
	if err := wire.Send(context.Background(), "dddd"); err != nil {
		t.Fatalf("canceled send retained its byte reservation: %v", err)
	}
	if got := awaitWireText(t, socket.writeStarted); got != "dddd" || socket.writeOverlap.Load() {
		t.Fatalf("unexpected queued delivery %q or concurrent physical writers", got)
	}
}

func TestDeviceWirePhysicalWriteFailureClosesWithoutReplay(t *testing.T) {
	failure := errors.New("physical send failed")
	wire, socket := wireFixture(t, smallWireOptions(), func(socket *controlledWireSocket) {
		socket.write = func(context.Context, string) error { return failure }
	})
	if err := wire.Send(context.Background(), "message"); !errors.Is(err, devices.ErrWireTransport) || !errors.Is(err, failure) {
		t.Fatalf("send failure = %v, want original physical cause", err)
	}
	awaitWireSignal(t, socket.closeStarted)
	if err := wire.Send(context.Background(), "again"); !errors.Is(err, devices.ErrWireTransport) {
		t.Fatalf("closed carrier accepted another send: %v", err)
	}
	if got := awaitWireText(t, socket.writeStarted); got != "message" {
		t.Fatalf("unexpected physical delivery = %q", got)
	}
	select {
	case text := <-socket.writeStarted:
		t.Fatalf("failed write was replayed: %q", text)
	default:
	}
	if err := joinWire(t, wire); !errors.Is(err, failure) {
		t.Fatalf("send drain lost original cause: %v", err)
	}
}
