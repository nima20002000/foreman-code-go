package health

import (
	"context"
	"sync"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
)

type probe struct {
	check   app.Pinger
	timeout time.Duration
	mu      sync.Mutex
	active  *attempt
}

type attempt struct {
	done   chan struct{}
	once   sync.Once
	status string
}

func newProbe(check app.Pinger, timeout time.Duration) *probe {
	return &probe{check: check, timeout: timeout}
}

func (p *probe) start() *attempt {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active != nil {
		return p.active
	}
	current := &attempt{done: make(chan struct{})}
	p.active = current
	ctx, cancel := context.WithTimeout(context.Background(), p.timeout)
	stopDeadline := context.AfterFunc(ctx, func() { current.complete("unavailable") })
	go func() {
		status := "unavailable"
		if p.check != nil && p.check.Ping(ctx) == nil && ctx.Err() == nil {
			status = "ok"
		}
		current.complete(status)
		stopDeadline()
		cancel()
		// A timeout response remains shared until an uncooperative check finally finishes.
		p.mu.Lock()
		p.active = nil
		p.mu.Unlock()
	}()
	return current
}

func (a *attempt) complete(status string) {
	a.once.Do(func() {
		a.status = status
		close(a.done)
	})
}

func (a *attempt) result(ctx context.Context) string {
	select {
	case <-a.done:
		return a.status
	case <-ctx.Done():
		return "unavailable"
	}
}
