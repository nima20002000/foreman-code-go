package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// Client owns only the supplied bridge pipes. The caller owns the isolated
// process/profile and must obtain native process-closure evidence separately.
type Client struct {
	input     io.ReadCloser
	output    io.WriteCloser
	mu        sync.Mutex
	writes    [][]byte
	writeWake chan struct{}
	pending   map[string]chan response
	queries   map[string]*Query
	callbacks map[string]context.CancelFunc
	sequence  atomic.Uint64
	closed    chan struct{}
	closeOnce sync.Once
	err       error
}

func NewClient(input io.ReadCloser, output io.WriteCloser) *Client {
	c := &Client{input: input, output: output, pending: make(map[string]chan response),
		queries: make(map[string]*Query), callbacks: make(map[string]context.CancelFunc), closed: make(chan struct{}), writeWake: make(chan struct{}, 1)}
	go c.write()
	go c.read()
	return c
}

func (c *Client) Close() error {
	c.fail(ErrClosed)
	return nil
}

func (c *Client) fail(err error) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.err = err
		pending, queries, callbacks := c.pending, c.queries, c.callbacks
		c.pending = make(map[string]chan response)
		c.queries = make(map[string]*Query)
		c.callbacks = make(map[string]context.CancelFunc)
		close(c.closed)
		c.mu.Unlock()
		for _, result := range pending {
			result <- response{err: err}
		}
		for _, query := range queries {
			query.finish(err)
		}
		for _, cancel := range callbacks {
			cancel()
		}
		// Closing the pipes unblocks pending reads/writes; this does not assert
		// closure of the SDK's native process or its descendants.
		_ = c.input.Close()
		_ = c.output.Close()
	})
}

func (c *Client) send(value frame) error {
	value.JSONRPC = "2.0"
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	c.mu.Lock()
	if c.err != nil {
		err = c.err
		c.mu.Unlock()
		return err
	}
	c.writes = append(c.writes, encoded)
	c.mu.Unlock()
	select {
	case c.writeWake <- struct{}{}:
	default:
	}
	return nil
}

func (c *Client) write() {
	for {
		c.mu.Lock()
		if c.err != nil {
			c.mu.Unlock()
			return
		}
		if len(c.writes) == 0 {
			c.mu.Unlock()
			select {
			case <-c.writeWake:
			case <-c.closed:
				return
			}
			continue
		}
		encoded := c.writes[0]
		c.writes[0] = nil
		c.writes = c.writes[1:]
		c.mu.Unlock()
		for len(encoded) > 0 {
			written, err := c.output.Write(encoded)
			if err != nil {
				c.fail(err)
				return
			}
			if written == 0 {
				c.fail(io.ErrShortWrite)
				return
			}
			encoded = encoded[written:]
		}
	}
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	id := fmt.Sprintf("g%d", c.sequence.Add(1))
	result := make(chan response, 1)
	c.mu.Lock()
	if c.err != nil {
		err = c.err
		c.mu.Unlock()
		return nil, err
	}
	c.pending[id] = result
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	if err := c.send(frame{ID: id, Method: method, Params: encoded}); err != nil {
		c.fail(err)
		return nil, err
	}
	select {
	case value := <-result:
		return value.result, value.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *Client) read() {
	reader := bufio.NewReader(c.input)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) != 0 {
				err = io.ErrUnexpectedEOF
			}
			c.fail(err)
			return
		}
		var value frame
		if err := json.Unmarshal(line, &value); err != nil {
			c.fail(err)
			return
		}
		if value.JSONRPC != "2.0" {
			c.fail(errors.New("invalid Claude bridge protocol envelope"))
			return
		}
		if err := c.receive(value); err != nil {
			c.fail(err)
			return
		}
	}
}

func (c *Client) receive(value frame) error {
	if value.Method == "" {
		c.mu.Lock()
		pending := c.pending[value.ID]
		delete(c.pending, value.ID)
		c.mu.Unlock()
		if pending != nil {
			var err error
			if value.Error != nil {
				err = value.Error
			}
			pending <- response{result: value.Result, err: err}
		}
		return nil
	}
	if value.Method == "callback" {
		return c.receiveCallback(value)
	}
	if value.Method == "callback.cancel" {
		var params struct {
			CallbackID string `json:"callbackId"`
		}
		if err := json.Unmarshal(value.Params, &params); err != nil {
			return err
		}
		c.mu.Lock()
		cancel := c.callbacks[params.CallbackID]
		c.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return nil
	}
	var params struct {
		QueryID string          `json:"queryId"`
		Event   json.RawMessage `json:"event"`
		Error   *RemoteError    `json:"error"`
	}
	if err := json.Unmarshal(value.Params, &params); err != nil {
		return err
	}
	c.mu.Lock()
	query := c.queries[params.QueryID]
	if value.Method == "query.end" {
		delete(c.queries, params.QueryID)
	}
	c.mu.Unlock()
	if query == nil {
		return nil
	} // Late output can follow cancellation of an open request.
	switch value.Method {
	case "query.event":
		query.push(params.Event)
	case "query.end":
		var err error
		if params.Error != nil {
			err = params.Error
		}
		query.finish(err)
	default:
		return fmt.Errorf("unsupported Claude bridge notification %q", value.Method)
	}
	return nil
}

func (c *Client) receiveCallback(value frame) error {
	var params struct {
		QueryID string            `json:"queryId"`
		Name    string            `json:"name"`
		Args    []json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(value.Params, &params); err != nil {
		return err
	}
	if value.ID == "" {
		return &bridgeDiagnostic{message: "Claude callback has no request identity"}
	}
	c.mu.Lock()
	if _, exists := c.callbacks[value.ID]; exists {
		c.mu.Unlock()
		return errors.New("duplicate Claude callback request identity")
	}
	query := c.queries[params.QueryID]
	var handler Callback
	ctx := context.Background()
	if query != nil {
		handler = query.callbacks[params.Name]
		ctx = query.ctx
	}
	ctx, cancel := context.WithCancel(ctx)
	c.callbacks[value.ID] = cancel
	c.mu.Unlock()
	go func() {
		defer cancel()
		var result json.RawMessage
		var err error
		if handler == nil {
			err = &bridgeDiagnostic{message: "Claude callback is not registered"}
		} else {
			result, err = handler(ctx, params.Args)
		}
		c.mu.Lock()
		delete(c.callbacks, value.ID)
		c.mu.Unlock()
		answer := frame{ID: value.ID, Result: result}
		if err != nil {
			answer.Result = nil
			answer.Error = &RemoteError{Code: -32000, Message: err.Error()}
		} else if len(result) == 0 {
			answer.Result = json.RawMessage("null")
		}
		if err := c.send(answer); err != nil {
			c.fail(err)
		}
	}()
	return nil
}
