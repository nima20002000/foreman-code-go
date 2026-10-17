package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const workerStatusLimit = 2048

// ReadWorkerStatus inspects the explicitly selected state without creating it.
// A nil result means no process owns the state socket. The domain payload stays
// serialized so this boundary does not redefine shared connection/status types.
func ReadWorkerStatus(ctx context.Context, stateDirectory string) (json.RawMessage, error) {
	if err := context.Cause(ctx); err != nil {
		return nil, err
	}
	if err := workerPlatformError(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(stateDirectory) {
		return nil, failure("private_directory_required", "", nil)
	}
	canonical, err := filepath.EvalSymlinks(stateDirectory)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	name, err := workerSocketName(canonical)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(time.Second)
	if expires, ok := ctx.Deadline(); ok && expires.Before(deadline) {
		deadline = expires
	}
	connection, err := (&net.Dialer{Deadline: deadline}).DialContext(ctx, "unix", name)
	if err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, statusReadError(ctx, err)
	}
	defer connection.Close()
	cancelRead := context.AfterFunc(ctx, func() {
		// ignore: cancellation closes only this read connection; deferred Close
		// may already have closed it after an ordinary reply.
		_ = connection.Close()
	})
	defer cancelRead()
	bytes, err := readStatusBytes(ctx, connection)
	if err != nil {
		return nil, statusReadError(ctx, err)
	}
	if len(bytes) > workerStatusLimit {
		return nil, failure("worker_status_oversized", "Worker status exceeds the size limit.", nil)
	}
	var status map[string]json.RawMessage
	var active bool
	if err := json.Unmarshal(bytes, &status); err != nil || status == nil {
		return nil, failure("worker_status_invalid", "Worker status is invalid.", err)
	}
	if err := json.Unmarshal(status["active"], &active); err != nil || !active {
		return nil, failure("worker_status_invalid", "Worker status is invalid.", err)
	}
	return json.RawMessage(bytes), nil
}

func readStatusBytes(ctx context.Context, connection net.Conn) ([]byte, error) {
	buffer := make([]byte, workerStatusLimit+1)
	size := 0
	for size <= workerStatusLimit {
		if err := context.Cause(ctx); err != nil {
			return nil, err
		}
		// The frozen worker bounds socket inactivity, so each received chunk
		// renews the one-second timeout while the total byte limit stays fixed.
		deadline := time.Now().Add(time.Second)
		if expires, ok := ctx.Deadline(); ok && expires.Before(deadline) {
			deadline = expires
		}
		if err := connection.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		count, err := connection.Read(buffer[size:])
		size += count
		if errors.Is(err, io.EOF) {
			return buffer[:size], nil
		}
		if err != nil {
			return nil, err
		}
	}
	return buffer[:size], nil
}

func statusReadError(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return failure("worker_status_timeout", "Worker status timed out.", err)
	}
	return err
}
