package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"sync"
)

// Query is one native SDK stream. Native events are returned unchanged.
type Query struct {
	client    *Client
	id        string
	callbacks map[string]Callback
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	events    []json.RawMessage
	wake      chan struct{}
	ended     bool
	err       error
}

func (c *Client) Query(ctx context.Context, options json.RawMessage, callbacks map[string]Callback) (*Query, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(options) == 0 {
		options = json.RawMessage("{}")
	}
	queryCtx, cancel := context.WithCancel(context.Background())
	query := &Query{client: c, id: fmt.Sprintf("q%d", c.sequence.Add(1)), callbacks: make(map[string]Callback),
		ctx: queryCtx, cancel: cancel, wake: make(chan struct{}, 1)}
	names := make([]string, 0, len(callbacks))
	for name, callback := range callbacks {
		names = append(names, name)
		query.callbacks[name] = callback
	}
	sort.Strings(names)
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		cancel()
		return nil, err
	}
	c.queries[query.id] = query
	c.mu.Unlock()
	_, err := c.call(ctx, "query", map[string]any{"queryId": query.id, "options": options, "callbacks": names})
	if err != nil {
		query.finish(err)
		c.mu.Lock()
		delete(c.queries, query.id)
		c.mu.Unlock()
		encoded, _ := json.Marshal(map[string]string{"queryId": query.id})
		if sendErr := c.send(frame{Method: "query.close", Params: encoded}); sendErr != nil {
			c.fail(sendErr)
		}
		return nil, err
	}
	return query, nil
}

func (q *Query) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *Query) push(event json.RawMessage) {
	q.mu.Lock()
	if !q.ended {
		q.events = append(q.events, event)
	}
	q.mu.Unlock()
	q.signal()
}

func (q *Query) finish(err error) {
	q.mu.Lock()
	if !q.ended {
		q.ended = true
		q.err = err
	}
	q.mu.Unlock()
	q.cancel()
	q.signal()
}

func (q *Query) Next(ctx context.Context) (json.RawMessage, error) {
	for {
		q.mu.Lock()
		if len(q.events) > 0 {
			event := q.events[0]
			q.events[0] = nil
			q.events = q.events[1:]
			q.mu.Unlock()
			return event, nil
		}
		if q.ended {
			err := q.err
			q.mu.Unlock()
			if err == nil {
				err = io.EOF
			}
			return nil, err
		}
		q.mu.Unlock()
		select {
		case <-q.wake:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Send means the bridge accepted this input into its prompt stream. It does not
// manufacture native delivery or persistence evidence.
func (q *Query) Send(ctx context.Context, message json.RawMessage) error {
	_, err := q.client.call(ctx, "query.input", map[string]any{"queryId": q.id, "message": message})
	return err
}

func (q *Query) EndInput(ctx context.Context) error {
	_, err := q.client.call(ctx, "query.endInput", map[string]string{"queryId": q.id})
	return err
}

func (q *Query) Close(ctx context.Context) error {
	q.cancel()
	_, err := q.client.call(ctx, "query.close", map[string]string{"queryId": q.id})
	return err
}

func (q *Query) control(ctx context.Context, method string, args ...any) (json.RawMessage, error) {
	return q.client.call(ctx, "query."+method, map[string]any{"queryId": q.id, "args": args})
}

func (q *Query) Interrupt(ctx context.Context) (json.RawMessage, error) {
	return q.control(ctx, "interrupt")
}
func (q *Query) SetPermissionMode(ctx context.Context, mode string) error {
	if mode != "default" && mode != "plan" {
		return fmt.Errorf("unsupported Claude session permission mode %q", mode)
	}
	_, err := q.control(ctx, "setPermissionMode", mode)
	return err
}
func (q *Query) GetContextUsage(ctx context.Context, options json.RawMessage) (json.RawMessage, error) {
	return q.control(ctx, "getContextUsage", options)
}
func (q *Query) InitializationResult(ctx context.Context) (json.RawMessage, error) {
	return q.control(ctx, "initializationResult")
}
func (q *Query) MCPServerStatus(ctx context.Context) (json.RawMessage, error) {
	return q.control(ctx, "mcpServerStatus")
}
func (q *Query) SetMCPServers(ctx context.Context, servers json.RawMessage) (json.RawMessage, error) {
	return q.control(ctx, "setMcpServers", servers)
}
