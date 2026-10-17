package discovery

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// ErrPayloadChanged means the observed bytes cannot be bound to one file identity.
var ErrPayloadChanged = errors.New("Payload changed during fingerprinting")

type fingerprintIdentity struct {
	Device uint64
	Inode uint64
	Size int64
	ModifiedSeconds int64
	ModifiedNanoseconds int64
	ChangedSeconds int64
	ChangedNanoseconds int64
}

type cachedFingerprint struct {
	identity fingerprintIdentity
	fingerprint string
}

// PayloadFingerprintCache reuses digests only while the complete nanosecond
// native file identity is unchanged. Its zero value is ready for use.
type PayloadFingerprintCache struct {
	mu sync.Mutex
	entries map[string]cachedFingerprint
	order []string
}

var inventoryPayloadFingerprints PayloadFingerprintCache

// Fingerprint returns a full SHA-256 digest and rechecks identity after reads and
// cache hits. A removed, retargeted, replaced or concurrently edited file cannot
// reuse the earlier observation.
func (c *PayloadFingerprintCache) Fingerprint(ctx context.Context, file string, observation os.FileInfo) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	path, err := filepath.EvalSymlinks(file)
	if err != nil {
		return "", err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", err
	}
	before := observation
	if before == nil {
		before, err = os.Stat(path)
		if err != nil {
			return "", err
		}
	}
	if !before.Mode().IsRegular() {
		return "", errors.New("Payload is not a file")
	}
	identity, err := nativeFingerprintIdentity(before)
	if err != nil {
		return "", err
	}
	if cached, ok := c.cached(path, identity); ok {
		if err := unchanged(ctx, file, path, identity); err != nil {
			c.forget(path)
			return "", err
		}
		return cached, nil
	}
	c.forget(path)
	fingerprint, err := hashPayload(ctx, path)
	if err != nil {
		return "", err
	}
	if err := unchanged(ctx, file, path, identity); err != nil {
		return "", err
	}
	c.remember(path, identity, fingerprint)
	return fingerprint, nil
}

func hashPayload(ctx context.Context, path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	buffer := make([]byte, 64*1024)
	var readError error
	for {
		if readError = ctx.Err(); readError != nil {
			break
		}
		count, err := file.Read(buffer)
		if count > 0 {
			_, _ = hash.Write(buffer[:count]) // hash.Hash.Write cannot return an error.
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readError = err
			}
			break
		}
	}
	if err := errors.Join(readError, file.Close()); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func unchanged(ctx context.Context, file, resolved string, identity fingerprintIdentity) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	after, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	currentIdentity, err := nativeFingerprintIdentity(after)
	if err != nil {
		return err
	}
	currentPath, err := filepath.EvalSymlinks(file)
	if err != nil {
		return err
	}
	currentPath, err = filepath.Abs(currentPath)
	if err != nil {
		return err
	}
	if currentIdentity != identity || currentPath != resolved {
		return ErrPayloadChanged
	}
	return ctx.Err()
}

func (c *PayloadFingerprintCache) cached(path string, identity fingerprintIdentity) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[path]
	return entry.fingerprint, ok && entry.identity == identity
}

func (c *PayloadFingerprintCache) forget(path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, path)
	for index, entry := range c.order {
		if entry == path {
			c.order = append(c.order[:index], c.order[index+1:]...)
			return
		}
	}
}

func (c *PayloadFingerprintCache) remember(path string, identity fingerprintIdentity, fingerprint string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]cachedFingerprint)
	}
	if _, exists := c.entries[path]; !exists {
		if len(c.entries) >= 512 {
			delete(c.entries, c.order[0])
			c.order = c.order[1:]
		}
		c.order = append(c.order, path)
	}
	c.entries[path] = cachedFingerprint{identity: identity, fingerprint: fingerprint}
}

func unavailableIdentity() error {
	return errors.New("native payload file identity is unavailable on this platform")
}
