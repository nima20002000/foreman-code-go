// Package computers owns computer inspection and account observations.
package computers

import (
	"context"
	"sync"
	"time"
)

const accountObservationTTL = 30 * time.Second

// AccountCacheKey identifies the installed application and its authorization
// revision. The contract adapter maps Main's null revision to zero.
type AccountCacheKey struct {
	InstallationID        string
	AuthorizationRevision int64
}

// AccountObservationCache shares account probes without retaining caller
// authority. Every service read must authorize its caller and validate its
// target before consulting this cache, including when the observation is warm.
// T is opaque; generated contract validation and response copying belong to
// the service adapter. Callers must not mutate a returned cached value.
type AccountObservationCache[T any] struct {
	mu              sync.Mutex
	now             func() time.Time
	entries         map[AccountCacheKey]*accountObservation[T]
	refreshRequired map[AccountCacheKey]bool
}

type accountObservation[T any] struct {
	done    chan struct{}
	settled bool
	at      time.Time
	value   T
	err     error
}

// NewAccountObservationCache creates the account-specific thirty-second cache.
// A nil clock uses time.Now. The supplied clock must be safe for concurrent use.
func NewAccountObservationCache[T any](now func() time.Time) *AccountObservationCache[T] {
	if now == nil {
		now = time.Now
	}
	return &AccountObservationCache[T]{
		now: now, entries: make(map[AccountCacheKey]*accountObservation[T]),
		refreshRequired: make(map[AccountCacheKey]bool),
	}
}

// Read returns a warm observation or shares the currently pending probe.
// Explicit refresh still joins pending work. Freshness begins when a probe
// finishes, so a slow probe does not expire while it is in progress.
//
// ctx cancels only this waiter. probe must enforce its own bounded lifetime;
// the account service's remote probe uses its independent 25-second deadline.
// A probe failure is returned to every waiter and evicted for immediate retry.
// The adapter must log it and map it to unavailable account data as the public
// computer-account service does. A successful zero or nil result is cacheable.
func (c *AccountObservationCache[T]) Read(ctx context.Context, key AccountCacheKey, refresh bool,
	probe func(refresh bool) (T, error)) (T, error) {
	if err := ctx.Err(); err != nil {
		var zero T
		return zero, err
	}
	c.mu.Lock()
	refresh = refresh || c.refreshRequired[key]
	entry := c.entries[key]
	start := entry == nil || entry.settled && (refresh || c.now().Sub(entry.at) >= accountObservationTTL)
	if start {
		delete(c.refreshRequired, key)
		entry = &accountObservation[T]{done: make(chan struct{})}
		c.entries[key] = entry
	}
	c.mu.Unlock()
	if start {
		go c.observe(key, entry, refresh, probe)
	}
	select {
	case <-entry.done:
		return entry.value, entry.err
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}

// Invalidate forgets this installation's observation and makes the next new
// probe a refresh. An already pending read may finish for its existing waiters,
// but its completion cannot replace or evict a newer observation.
func (c *AccountObservationCache[T]) Invalidate(key AccountCacheKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
	c.refreshRequired[key] = true
}

func (c *AccountObservationCache[T]) observe(key AccountCacheKey, entry *accountObservation[T], refresh bool,
	probe func(bool) (T, error)) {
	value, err := probe(refresh)
	c.mu.Lock()
	defer c.mu.Unlock()
	entry.value = value
	entry.err = err
	entry.at = c.now()
	entry.settled = true
	if err != nil && c.entries[key] == entry {
		delete(c.entries, key)
	}
	close(entry.done)
}
