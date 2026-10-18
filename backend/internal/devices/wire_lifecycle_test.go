package devices_test

import (
	"context"
	"errors"
	"io"
	"strconv"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

func TestDeviceWireConsumeHandsOffQueuedFramesInOrder(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	queueWireFrame(t, socket, "one")
	queueWireFrame(t, socket, "two")
	gate, release := wireGate()
	defer release()
	entered := make(chan struct{})
	handled := make(chan string, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- wire.Consume(ctx, func(_ context.Context, text string) error {
			handled <- text
			if text == "one" {
				close(entered)
				<-gate
			}
			return nil
		})
	}()
	awaitWireSignal(t, entered)
	if _, err := wire.Next(context.Background()); !errors.Is(err, devices.ErrWireReaderBusy) {
		t.Fatalf("concurrent logical reader = %v, want reader ownership failure", err)
	}
	// The physical reader may already receive this frame, but its callback
	// cannot overtake either previously queued frame during the handoff.
	sendWireInput(t, socket, wireInput{text: "three"})
	release()
	awaitWireSignal(t, socket.readStarted)
	for _, want := range []string{"one", "two", "three"} {
		if got := awaitWireText(t, handled); got != want {
			t.Fatalf("handoff frame = %q, want %q", got, want)
		}
	}
	for index := range 8 {
		text := strconv.Itoa(index)
		queueWireFrame(t, socket, text)
		if got := awaitWireText(t, handled); got != text {
			t.Fatalf("direct frame = %q, want %q", got, text)
		}
	}
	cancel()
	if err := awaitWireResult(t, result); err != nil {
		t.Fatalf("clean consumption cancellation failed: %v", err)
	}
	if err := joinWire(t, wire); err != nil || socket.closeCount.Load() != 1 {
		t.Fatalf("consumer cleanup = %v, %d closes", err, socket.closeCount.Load())
	}
}

func TestDeviceWireConsumeFailureDiscardsRemainingQueuedFrames(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	queueWireFrame(t, socket, "bad")
	queueWireFrame(t, socket, "unused")
	failure := errors.New("protocol adapter rejected frame")
	var handled []string
	err := wire.Consume(context.Background(), func(_ context.Context, text string) error {
		handled = append(handled, text)
		return failure
	})
	if !errors.Is(err, failure) || len(handled) != 1 || handled[0] != "bad" {
		t.Fatalf("failed consumer = %v, frames=%v; want one rejected frame", err, handled)
	}
	if err := joinWire(t, wire); !errors.Is(err, failure) {
		t.Fatalf("consumer drain lost failure: %v", err)
	}
}

func TestDeviceWireCallbackCloseDiscardsRemainingQueuedFrames(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	queueWireFrame(t, socket, "first")
	queueWireFrame(t, socket, "unused")
	calls := 0
	err := wire.Consume(context.Background(), func(context.Context, string) error {
		calls++
		wire.Close()
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatalf("callback close = %v, %d calls; want one delivered frame", err, calls)
	}
	if err := joinWire(t, wire); err != nil {
		t.Fatalf("callback close failed cleanup: %v", err)
	}
}

func TestDeviceWireJoinWaitsForDirectConsumerSettlement(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	gate, release := wireGate()
	defer release()
	ready, entered := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- wire.Consume(ctx, func(_ context.Context, text string) error {
			if text == "ready" {
				close(ready)
			} else {
				close(entered)
				<-gate
			}
			return nil
		})
	}()
	queueWireFrame(t, socket, "ready")
	awaitWireSignal(t, ready)
	sendWireInput(t, socket, wireInput{text: "held"})
	awaitWireSignal(t, entered)
	cancel()
	if err := awaitWireResult(t, result); err != nil {
		t.Fatalf("logical consumer stop = %v, want clean cancellation", err)
	}
	assertWireStillJoining(t, wire)
	release()
	if err := joinWire(t, wire); err != nil {
		t.Fatalf("settled consumer failed cleanup: %v", err)
	}
}

func TestDeviceWireJoinWaitsForQueuedConsumerSettlement(t *testing.T) {
	wire, socket := wireFixture(t, smallWireOptions(), nil)
	queueWireFrame(t, socket, "held")
	gate, release := wireGate()
	defer release()
	entered := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- wire.Consume(context.Background(), func(context.Context, string) error {
			close(entered)
			<-gate
			return nil
		})
	}()
	awaitWireSignal(t, entered)
	wire.Close()
	awaitWireSignal(t, socket.closeStarted)
	assertWireStillJoining(t, wire)
	release()
	if err := awaitWireResult(t, result); err != nil {
		t.Fatalf("queued consumer close failed: %v", err)
	}
	if err := joinWire(t, wire); err != nil {
		t.Fatalf("queued callback did not drain: %v", err)
	}
}

func TestDeviceWireCloseWaitsForCarrierShutdownAndRejectsNewWork(t *testing.T) {
	gate, release := wireGate()
	defer release()
	closeFailure := errors.New("physical close failed after settlement")
	wire, socket := wireFixture(t, smallWireOptions(), func(socket *controlledWireSocket) {
		socket.close = func() error {
			<-gate
			return closeFailure
		}
	})
	wire.Close()
	wire.Close()
	awaitWireSignal(t, socket.closeStarted)
	if _, err := wire.Next(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatalf("closed read = %v, want end of stream", err)
	}
	if err := wire.Send(context.Background(), "later"); !errors.Is(err, devices.ErrWireTransport) {
		t.Fatalf("closed send = %v, want transport failure", err)
	}
	assertWireStillJoining(t, wire)
	release()
	if err := joinWire(t, wire); !errors.Is(err, closeFailure) || socket.closeCount.Load() != 1 {
		t.Fatalf("settled close = %v, %d calls; want original failure and one close", err, socket.closeCount.Load())
	}
}

func TestDeviceWireJoinWaitsForPhysicalWriteSettlement(t *testing.T) {
	gate, release := wireGate()
	defer release()
	wire, socket := wireFixture(t, smallWireOptions(), func(socket *controlledWireSocket) {
		socket.write = func(context.Context, string) error {
			<-gate
			return nil
		}
	})
	result := make(chan error, 1)
	go func() { result <- wire.Send(context.Background(), "held") }()
	if got := awaitWireText(t, socket.writeStarted); got != "held" {
		t.Fatalf("physical send = %q", got)
	}
	wire.Close()
	awaitWireSignal(t, socket.closeStarted)
	assertWireStillJoining(t, wire)
	release()
	if err := awaitWireResult(t, result); err != nil {
		t.Fatalf("settled physical send returned %v", err)
	}
	if err := joinWire(t, wire); err != nil {
		t.Fatalf("settled physical writer did not drain: %v", err)
	}
}

func TestDeviceWireParentCancellationClosesAndDrainsCarrier(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	socket := newControlledWireSocket()
	wire, err := devices.NewDeviceWire(ctx, socket, smallWireOptions())
	if err != nil {
		t.Fatalf("create cancelable wire: %v", err)
	}
	t.Cleanup(func() {
		wire.Close()
		joinWire(t, wire)
	})
	awaitWireSignal(t, socket.readStarted)
	cancel()
	awaitWireSignal(t, socket.closeStarted)
	if _, err := wire.Next(context.Background()); !errors.Is(err, devices.ErrWireTransport) || !errors.Is(err, context.Canceled) {
		t.Fatalf("parent cancellation = %v, want transport with cancellation cause", err)
	}
	if err := joinWire(t, wire); !errors.Is(err, context.Canceled) || socket.closeCount.Load() != 1 {
		t.Fatalf("canceled carrier cleanup = %v, %d closes", err, socket.closeCount.Load())
	}
}

func TestDeviceWireRequiresExplicitValidBounds(t *testing.T) {
	tests := []devices.WireLimits{
		{},
		{FrameBytes: 0, BufferBytes: 8, QueueDepth: 2},
		{FrameBytes: 8, BufferBytes: 7, QueueDepth: 2},
		{FrameBytes: 8, BufferBytes: 16, QueueDepth: 0},
	}
	for _, limits := range tests {
		socket := newControlledWireSocket()
		wire, err := devices.NewDeviceWire(context.Background(), socket, devices.WireOptions{Limits: limits})
		if err == nil || wire != nil || socket.readCount.Load() != 0 || socket.closeCount.Load() != 0 {
			t.Fatalf("invalid bounds started a carrier: wire=%v, error=%v", wire, err)
		}
	}
}

func TestDeviceWireContextAwareConsumerCancellationIsClean(t *testing.T) {
	for _, queued := range []bool{false, true} {
		t.Run(strconv.FormatBool(queued), func(t *testing.T) {
			wire, socket := wireFixture(t, smallWireOptions(), nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ready, entered := make(chan struct{}), make(chan struct{})
			if queued {
				queueWireFrame(t, socket, "held")
			}
			result := make(chan error, 1)
			go func() {
				result <- wire.Consume(ctx, func(callbackContext context.Context, text string) error {
					if text == "ready" {
						close(ready)
						return nil
					}
					close(entered)
					<-callbackContext.Done()
					return callbackContext.Err()
				})
			}()
			if !queued {
				queueWireFrame(t, socket, "ready")
				awaitWireSignal(t, ready)
				sendWireInput(t, socket, wireInput{text: "held"})
			}
			awaitWireSignal(t, entered)
			cancel()
			if err := awaitWireResult(t, result); err != nil {
				t.Fatalf("callback cancellation became a transport failure: %v", err)
			}
			if err := joinWire(t, wire); err != nil {
				t.Fatalf("context-aware callback cancellation did not drain cleanly: %v", err)
			}
		})
	}
}

func TestDeviceWireLifetimeDeadlineHasOneTerminalClassification(t *testing.T) {
	for _, operation := range []string{"read", "direct-consumer", "queued-consumer", "write"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			socket := newControlledWireSocket()
			if operation == "write" {
				socket.write = func(writeContext context.Context, _ string) error {
					<-writeContext.Done()
					return writeContext.Err()
				}
			}
			wire, err := devices.NewDeviceWire(ctx, socket, smallWireOptions())
			if err != nil {
				t.Fatalf("create deadline-bound wire: %v", err)
			}
			t.Cleanup(func() {
				wire.Close()
				joinWire(t, wire)
			})
			awaitWireSignal(t, socket.readStarted)
			var result chan error
			switch operation {
			case "write":
				result = make(chan error, 1)
				go func() { result <- wire.Send(context.Background(), "held") }()
				if got := awaitWireText(t, socket.writeStarted); got != "held" {
					t.Fatalf("deadline writer started with %q", got)
				}
			case "direct-consumer", "queued-consumer":
				ready, entered := make(chan struct{}), make(chan struct{})
				if operation == "queued-consumer" {
					queueWireFrame(t, socket, "held")
				}
				result = make(chan error, 1)
				go func() {
					result <- wire.Consume(context.Background(), func(callbackContext context.Context, text string) error {
						if text == "ready" {
							close(ready)
							return nil
						}
						close(entered)
						<-callbackContext.Done()
						return callbackContext.Err()
					})
				}()
				if operation == "direct-consumer" {
					queueWireFrame(t, socket, "ready")
					awaitWireSignal(t, ready)
					sendWireInput(t, socket, wireInput{text: "held"})
				}
				awaitWireSignal(t, entered)
			}
			awaitWireSignal(t, socket.closeStarted)
			if result != nil {
				if err := awaitWireResult(t, result); !errors.Is(err, devices.ErrWireTimeout) || !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("owned deadline became a different operation failure: %v", err)
				}
			}
			if _, err := wire.Next(context.Background()); !errors.Is(err, devices.ErrWireTimeout) || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("owned deadline has nondeterministic terminal code: %v", err)
			}
			if err := joinWire(t, wire); !errors.Is(err, devices.ErrWireTimeout) || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("deadline classification changed during physical drain: %v", err)
			}
		})
	}
}

func assertWireStillJoining(t *testing.T, wire *devices.DeviceWire) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if err := wire.Join(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("physical work was reported drained before it settled: %v", err)
	}
}
