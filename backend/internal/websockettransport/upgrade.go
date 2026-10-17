// Package websockettransport provides the shared authenticated HTTP upgrade boundary.
package websockettransport

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"

	"github.com/coder/websocket"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

// Options supplies the lane's existing access policy and synchronous connection owner.
type Options struct {
	// Authorize must enforce the source Host, Origin and credential policy on every
	// request. Its non-nil context carries the authenticated generated principal.
	Authorize func(*http.Request) (context.Context, error)
	// Serve owns the connection until it returns, including domain frames, close
	// statuses, deadlines, queues and cancellation. It must use the supplied context.
	Serve func(context.Context, *websocket.Conn) error
	// ReadLimit is the source contract's maximum message payload in bytes.
	// There is no shared default: the registering lane supplies its existing limit.
	ReadLimit int64
}

// New constructs a handler without creating a listener or starting background work.
// Register it through App.RegisterStream so errors after the 101 response are logged.
func New(options Options) (httpserver.Handler, error) {
	if options.Authorize == nil || options.Serve == nil {
		return nil, fmt.Errorf("WebSocket transport requires authorization and connection handlers")
	}
	// coder/websocket internally adds one byte to detect a limit violation.
	if options.ReadLimit <= 0 || options.ReadLimit == math.MaxInt64 {
		return nil, fmt.Errorf("WebSocket read limit must be positive and below MaxInt64")
	}
	return func(w http.ResponseWriter, request *http.Request) (err error) {
		// Frozen deviceCarrier.ts destroys an offered-extension connection before
		// authentication. ErrAbortHandler gives net/http the same response abort.
		extensions := request.Header.Values("Sec-WebSocket-Extensions")
		if len(extensions) > 1 || len(extensions) == 1 && extensions[0] != "" {
			panic(http.ErrAbortHandler)
		}
		authorized, err := options.Authorize(request)
		if err != nil {
			return err
		}
		if authorized == nil {
			return fmt.Errorf("WebSocket authorization returned no request context")
		}
		if err := request.Context().Err(); err != nil {
			return err
		}
		ctx, cancel := context.WithCancel(authorized)
		stopCancellation := context.AfterFunc(request.Context(), cancel)
		defer stopCancellation()
		defer cancel()
		if err := ctx.Err(); err != nil {
			return err
		}
		connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{
			// This flag concerns HTTP Origin only. Authorize owns that existing
			// policy; applying the library's host allowlist would change it.
			InsecureSkipVerify: true,
			CompressionMode:    websocket.CompressionDisabled,
		})
		if err != nil {
			return err
		}
		connection.SetReadLimit(options.ReadLimit)
		defer func() {
			// Serve owns any domain close handshake. Reclaim the underlying socket
			// when it returns, including a callback failure that left it open.
			if closeErr := connection.CloseNow(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
				err = errors.Join(err, closeErr)
			}
		}()
		return options.Serve(ctx, connection)
	}, nil
}
