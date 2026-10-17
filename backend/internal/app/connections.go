package app

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
)

// connections tracks sockets that never sent a request; shutdown need not wait for them.
type connections struct {
	mu      sync.Mutex
	unused  map[net.Conn]struct{}
	closing bool
	logger  *slog.Logger
}

func newConnections(logger *slog.Logger) *connections {
	return &connections{unused: make(map[net.Conn]struct{}), logger: logger}
}

func (c *connections) observe(connection net.Conn, state http.ConnState) {
	c.mu.Lock()
	if state == http.StateNew && !c.closing {
		c.unused[connection] = struct{}{}
	} else {
		delete(c.unused, connection)
	}
	closing := c.closing && state == http.StateNew
	c.mu.Unlock()
	if closing {
		// HTTP shutdown owns this accepted-but-unused socket.
		if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			c.logger.Error("unused HTTP connection could not close", "error", err)
		}
	}
}

func (c *connections) close() error {
	c.mu.Lock()
	c.closing = true
	unused := c.unused
	c.unused = make(map[net.Conn]struct{})
	c.mu.Unlock()
	var failures []error
	for connection := range unused {
		if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
