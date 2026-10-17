package cihost

import (
	"context"
	"sync"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// CloudTokenSource resolves a token for one API origin. Adapters retain the TS
// credential-store host checks; this transport never reads a real login itself.
type CloudTokenSource func(context.Context, CloudProviderKind, string) (string, error)

type cloudCredentialKey struct {
	provider CloudProviderKind
	endpoint string
}

type cloudCredentialEntry struct {
	ready     chan struct{}
	token     string
	err       error
	expiresAt time.Time
}

// CloudCredentialCache shares concurrent loads and rejected-token refreshes.
// A token is never reused by a client pointed at another API origin.
type CloudCredentialCache struct {
	mu      sync.Mutex
	source  CloudTokenSource
	now     func() time.Time
	entries map[cloudCredentialKey]*cloudCredentialEntry
}

func NewCloudCredentialCache(source CloudTokenSource, now func() time.Time) *CloudCredentialCache {
	if now == nil {
		now = time.Now
	}
	return &CloudCredentialCache{source: source, now: now, entries: make(map[cloudCredentialKey]*cloudCredentialEntry)}
}

func (cache *CloudCredentialCache) resolve(ctx context.Context, key cloudCredentialKey) (*cloudCredentialEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cache.mu.Lock()
	entry := cache.entries[key]
	if entry != nil && !entry.expiresAt.IsZero() && !cache.now().Before(entry.expiresAt) {
		delete(cache.entries, key)
		entry = nil
	}
	load := entry == nil
	if load {
		entry = &cloudCredentialEntry{ready: make(chan struct{})}
		cache.entries[key] = entry
	}
	cache.mu.Unlock()
	if load {
		// The TS shared token promise is independent of request AbortSignals.
		// Each waiter can cancel without canceling another waiter's credential
		// lookup. The credential adapter owns its existing native lookup deadline.
		go cache.load(context.WithoutCancel(ctx), key, entry)
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-entry.ready:
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return entry, entry.err
	}
}

func (cache *CloudCredentialCache) load(ctx context.Context, key cloudCredentialKey, entry *cloudCredentialEntry) {
	var token string
	var err error
	if cache.source != nil {
		token, err = cache.source(ctx, key.provider, key.endpoint)
	}
	if err != nil {
		token = ""
		if key.provider == CloudCircleCI {
			err = domainerror.New("CI_CLOUD_CREDENTIALS_UNAVAILABLE", "CircleCI credential configuration could not be read.", 503, nil)
		} else {
			// GitHub token lookup failures select the existing visible CLI fallback.
			err = nil
		}
	}
	cache.mu.Lock()
	entry.token, entry.err = token, err
	if err != nil && cache.entries[key] == entry {
		delete(cache.entries, key)
	} else if token == "" {
		entry.expiresAt = cache.now().Add(30 * time.Second)
	}
	close(entry.ready)
	cache.mu.Unlock()
}

func (cache *CloudCredentialCache) reject(key cloudCredentialKey, rejected *cloudCredentialEntry) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.entries[key] == rejected {
		delete(cache.entries, key)
	}
}
