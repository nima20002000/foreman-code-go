package devices

import (
	"context"
	"errors"
	"io"
	"sync"
)

var (
	ErrWireBackpressure   = &WireError{code: "backpressure"}
	ErrWireMalformedFrame = &WireError{code: "malformed-frame"}
	ErrWireTimeout        = &WireError{code: "timeout"}
	ErrWireTransport      = &WireError{code: "transport"}
	ErrWireReaderBusy     = errors.New("device wire already has a reader")
)

// WireError is an internal transport failure, not a generated wire DTO.
// The protocol adapter maps Code to its shared failure contract. Diagnostic
// causes remain available to the owner without becoming part of that code.
type WireError struct {
	code  string
	cause error
}

func (failure *WireError) Error() string { return failure.code }
func (failure *WireError) Code() string  { return failure.code }
func (failure *WireError) Unwrap() error { return failure.cause }

func (failure *WireError) Is(target error) bool {
	other, ok := target.(*WireError)
	return ok && other != nil && failure.code == other.code
}

// WireLimits must come from the generated device-connection contract adapter.
// There are deliberately no local defaults or copied protocol constants.
type WireLimits struct {
	FrameBytes  int
	BufferBytes int
	QueueDepth  int
}

// WireSocket is the small carrier port shared by Main and worker transports.
// Read has one physical caller. Write sends a text message and returns only
// when that send has settled; it must not hide another unbounded send queue.
// Close must unblock Read and Write, and all methods must respect cancellation.
// A normal peer close is io.EOF. The concrete coder/websocket adapter is separate.
type WireSocket interface {
	Read(context.Context) (text string, binary bool, err error)
	Write(context.Context, string) error
	Close() error
}

// WireOptions keeps contract parsing outside the opaque transport. When set,
// TerminalFailure examines each text frame before it enters the unread queue.
// The generated adapter returns an error only for a valid terminal blocked
// frame. This preserves that reason if the peer closes before Next consumes it.
type WireOptions struct {
	Limits          WireLimits
	TerminalFailure func(string) error
}

type wireConsumer struct {
	ctx    context.Context
	handle func(context.Context, string) error
}

// DeviceWire owns the bounded unread queue and all physical carrier work.
// Frames stay opaque. Next may hand the stream to Consume after the handshake;
// Consume delivers in order without building another unread queue. Close stops
// admission immediately; Join waits for reads, writes, callbacks and Close.
type DeviceWire struct {
	socket  WireSocket
	options WireOptions
	ctx     context.Context
	cancel  context.CancelFunc

	mu              sync.Mutex
	delivery        sync.Mutex
	queue           []string
	queuedBytes     int
	pendingBytes    int
	activeWrites    int
	activeConsumers int
	reading         bool
	consumer        *wireConsumer
	closed          bool
	failure         error
	terminalFailure error
	closeFailure    error
	readDone        bool
	closeDone       bool
	joined          bool
	changed         chan struct{}
	stopped         chan struct{}
	done            chan struct{}
	writer          chan struct{}
}

func NewDeviceWire(ctx context.Context, socket WireSocket, options WireOptions) (*DeviceWire, error) {
	limits := options.Limits
	if socket == nil || limits.FrameBytes <= 0 || limits.BufferBytes < limits.FrameBytes || limits.QueueDepth <= 0 {
		return nil, errors.New("invalid device wire configuration")
	}
	lifetime, cancel := context.WithCancel(ctx)
	wire := &DeviceWire{
		socket: socket, options: options, ctx: lifetime, cancel: cancel,
		changed: make(chan struct{}), stopped: make(chan struct{}),
		done: make(chan struct{}), writer: make(chan struct{}, 1),
	}
	wire.writer <- struct{}{}
	go wire.readLoop()
	go wire.closeLoop()
	return wire, nil
}

func (wire *DeviceWire) signalLocked() {
	close(wire.changed)
	wire.changed = make(chan struct{})
}

func (wire *DeviceWire) finish(failure error) {
	wire.mu.Lock()
	defer wire.mu.Unlock()
	if wire.closed {
		return
	}
	wire.closed = true
	wire.failure = failure
	wire.queue = nil
	wire.queuedBytes = 0
	close(wire.stopped)
	wire.signalLocked()
	wire.cancel()
}

func (wire *DeviceWire) finishJoinLocked() {
	if !wire.joined && wire.readDone && wire.closeDone && wire.activeWrites == 0 && wire.activeConsumers == 0 {
		wire.joined = true
		close(wire.done)
	}
}

func (wire *DeviceWire) readLoop() {
	defer func() {
		wire.mu.Lock()
		wire.readDone = true
		wire.finishJoinLocked()
		wire.mu.Unlock()
	}()
	for {
		if wire.ctx.Err() != nil {
			wire.finish(wireContextFailure(wire.ctx.Err()))
			return
		}
		text, binary, err := wire.socket.Read(wire.ctx)
		if err != nil {
			if lifetimeError := wire.ctx.Err(); lifetimeError != nil {
				wire.finish(wireContextFailure(lifetimeError))
				return
			}
			wire.mu.Lock()
			terminal := wire.terminalFailure
			wire.mu.Unlock()
			if errors.Is(err, io.EOF) {
				wire.finish(terminal)
			} else {
				wire.finish(&WireError{code: "transport", cause: err})
			}
			return
		}
		if binary {
			wire.finish(ErrWireMalformedFrame)
			return
		}
		if !wire.receive(text) {
			return
		}
	}
}

func (wire *DeviceWire) receive(text string) bool {
	wire.delivery.Lock()
	defer wire.delivery.Unlock()
	if len(text) > wire.options.Limits.FrameBytes {
		wire.finish(ErrWireBackpressure)
		return false
	}
	var terminal error
	if wire.options.TerminalFailure != nil {
		terminal = wire.options.TerminalFailure(text)
	}
	wire.mu.Lock()
	if wire.closed {
		wire.mu.Unlock()
		return false
	}
	consumer := wire.consumer
	if consumer == nil {
		if len(wire.queue) >= wire.options.Limits.QueueDepth || len(text) > wire.options.Limits.BufferBytes-wire.queuedBytes {
			wire.mu.Unlock()
			wire.finish(ErrWireBackpressure)
			return false
		}
		if terminal != nil {
			wire.terminalFailure = terminal
		}
		wire.queue = append(wire.queue, text)
		wire.queuedBytes += len(text)
		wire.signalLocked()
		wire.mu.Unlock()
		return true
	}
	wire.mu.Unlock()
	if err := consumer.handle(consumer.ctx, text); err != nil {
		wire.finishConsumer(consumer, err)
		return false
	}
	return true
}

func (wire *DeviceWire) closeLoop() {
	<-wire.ctx.Done()
	wire.finish(wireContextFailure(wire.ctx.Err()))
	err := wire.socket.Close()
	wire.mu.Lock()
	wire.closeFailure = err
	wire.closeDone = true
	wire.finishJoinLocked()
	wire.mu.Unlock()
}

func wireContextFailure(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &WireError{code: "timeout", cause: err}
	}
	return &WireError{code: "transport", cause: err}
}

// Next waits for one unread frame. A canceled or expired wait does not consume
// a later frame or close the carrier. Only one Next or Consume may run at once.
func (wire *DeviceWire) Next(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", wireContextFailure(err)
	}
	wire.mu.Lock()
	if wire.reading {
		wire.mu.Unlock()
		return "", ErrWireReaderBusy
	}
	wire.reading = true
	wire.mu.Unlock()
	defer func() {
		wire.mu.Lock()
		wire.reading = false
		wire.mu.Unlock()
	}()
	for {
		if err := ctx.Err(); err != nil {
			return "", wireContextFailure(err)
		}
		wire.mu.Lock()
		if wire.closed {
			failure := wire.failure
			wire.mu.Unlock()
			if failure == nil {
				failure = io.EOF
			}
			return "", failure
		}
		if len(wire.queue) != 0 {
			text := wire.queue[0]
			wire.queue[0] = ""
			wire.queue = wire.queue[1:]
			wire.queuedBytes -= len(text)
			wire.mu.Unlock()
			return text, nil
		}
		changed := wire.changed
		wire.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return "", wireContextFailure(ctx.Err())
		}
	}
}

// Consume transfers unread and future frames to one synchronous ordered
// callback. Canceling consumption closes the stream cleanly, matching the
// frozen iterator's abort behavior. Callbacks must observe their context;
// Join remains the physical cleanup boundary after Consume returns.
func (wire *DeviceWire) Consume(ctx context.Context, handle func(context.Context, string) error) error {
	wire.mu.Lock()
	if wire.closed {
		failure := wire.failure
		wire.mu.Unlock()
		return failure
	}
	if wire.reading {
		wire.mu.Unlock()
		return ErrWireReaderBusy
	}
	wire.reading = true
	wire.activeConsumers++
	wire.mu.Unlock()
	consumerContext, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(wire.ctx, cancel)
	defer func() {
		stop()
		cancel()
		wire.mu.Lock()
		wire.activeConsumers--
		wire.reading = false
		wire.finishJoinLocked()
		wire.mu.Unlock()
	}()
	consumer := &wireConsumer{ctx: consumerContext, handle: handle}
	wire.installConsumer(consumer)
	select {
	case <-ctx.Done():
		wire.finishConsumer(consumer, nil)
	case <-wire.stopped:
	}
	wire.mu.Lock()
	failure := wire.failure
	wire.mu.Unlock()
	return failure
}

func (wire *DeviceWire) installConsumer(consumer *wireConsumer) {
	wire.delivery.Lock()
	defer wire.delivery.Unlock()
	wire.mu.Lock()
	if wire.closed {
		wire.mu.Unlock()
		return
	}
	if consumer.ctx.Err() != nil {
		wire.mu.Unlock()
		wire.finishConsumer(consumer, nil)
		return
	}
	wire.consumer = consumer
	queued := wire.queue
	wire.queue = nil
	wire.queuedBytes = 0
	wire.mu.Unlock()
	for _, text := range queued {
		wire.mu.Lock()
		closed := wire.closed
		wire.mu.Unlock()
		if closed {
			return
		}
		if consumer.ctx.Err() != nil {
			wire.finishConsumer(consumer, nil)
			return
		}
		if err := consumer.handle(consumer.ctx, text); err != nil {
			wire.finishConsumer(consumer, err)
			return
		}
	}
}

func (wire *DeviceWire) finishConsumer(consumer *wireConsumer, err error) {
	if lifetimeError := wire.ctx.Err(); lifetimeError != nil {
		wire.finish(wireContextFailure(lifetimeError))
		return
	}
	if cancellation := consumer.ctx.Err(); cancellation != nil && (err == nil || errors.Is(err, cancellation)) {
		wire.finish(nil)
		return
	}
	wire.finish(err)
}

// Send reserves bytes before waiting for the single physical writer. Rejected
// or canceled queued sends release their reservation without closing the link.
// A physical write failure ends the connection; its result is never replayed.
func (wire *DeviceWire) Send(ctx context.Context, text string) error {
	if err := ctx.Err(); err != nil {
		return wireContextFailure(err)
	}
	wire.mu.Lock()
	if wire.closed {
		wire.mu.Unlock()
		return ErrWireTransport
	}
	if len(text) > wire.options.Limits.FrameBytes || len(text) > wire.options.Limits.BufferBytes-wire.pendingBytes {
		wire.mu.Unlock()
		return ErrWireBackpressure
	}
	wire.pendingBytes += len(text)
	wire.activeWrites++
	wire.mu.Unlock()
	defer func() {
		wire.mu.Lock()
		wire.pendingBytes -= len(text)
		wire.activeWrites--
		wire.finishJoinLocked()
		wire.mu.Unlock()
	}()
	select {
	case <-wire.ctx.Done():
		return wireContextFailure(wire.ctx.Err())
	case <-ctx.Done():
		return wireContextFailure(ctx.Err())
	case <-wire.writer:
	}
	defer func() { wire.writer <- struct{}{} }()
	writeContext, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(wire.ctx, cancel)
	defer func() { stop(); cancel() }()
	if err := wire.ctx.Err(); err != nil {
		return wireContextFailure(err)
	}
	if err := writeContext.Err(); err != nil {
		return wireContextFailure(err)
	}
	if err := wire.socket.Write(writeContext, text); err != nil {
		var failure error = &WireError{code: "transport", cause: err}
		if lifetimeError := wire.ctx.Err(); lifetimeError != nil {
			failure = wireContextFailure(lifetimeError)
		} else if cancellation := writeContext.Err(); cancellation != nil {
			failure = wireContextFailure(cancellation)
		}
		wire.finish(failure)
		return failure
	}
	return nil
}

func (wire *DeviceWire) Close() { wire.finish(nil) }

// Join reports terminal and physical-close failures only after every owned
// physical operation has settled. Canceling a Join wait does not fake cleanup.
func (wire *DeviceWire) Join(ctx context.Context) error {
	select {
	case <-wire.done:
		wire.mu.Lock()
		failure := errors.Join(wire.failure, wire.closeFailure)
		wire.mu.Unlock()
		return failure
	case <-ctx.Done():
		return ctx.Err()
	}
}
