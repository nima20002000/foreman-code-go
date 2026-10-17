package worker

import (
	"encoding/json"
	"errors"
	"net"
	"sync"
	"syscall"
	"time"
)

// StatusProvider serializes the current public status using the owner's contract.
// It must be safe for concurrent calls and return immutable JSON bytes.
type StatusProvider func() json.RawMessage

// WorkerLock owns the installed worker's process-lifetime state socket. Callers
// keep it until transport and domain cleanup completes, including failed drains.
type WorkerLock struct {
	listener *net.UnixListener
	status   StatusProvider
	wait     sync.WaitGroup
	once     sync.Once
	mu       sync.Mutex
	closed   bool
	failure  error
	closeErr error
}

// AcquireWorkerLock prevents two processes from using the same canonical state.
// The operating system releases the abstract socket when its owner exits.
func AcquireWorkerLock(stateDirectory string, status StatusProvider) (*WorkerLock, error) {
	canonical, err := RequirePrivateDirectory(stateDirectory)
	if err != nil {
		return nil, err
	}
	name, err := workerSocketName(canonical)
	if err != nil {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: name, Net: "unix"})
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			return nil, failure("worker_already_running", "", err)
		}
		return nil, err
	}
	if status == nil {
		status = func() json.RawMessage { return json.RawMessage(`{"active":true}`) }
	}
	lock := &WorkerLock{listener: listener, status: status}
	lock.wait.Add(1)
	go lock.accept()
	return lock, nil
}

func (lock *WorkerLock) accept() {
	defer lock.wait.Done()
	for {
		client, err := lock.listener.AcceptUnix()
		if err != nil {
			lock.mu.Lock()
			if !lock.closed {
				lock.failure = err
				lock.closed = true
			}
			lock.mu.Unlock()
			return
		}
		lock.wait.Add(1)
		go lock.reply(client)
	}
}

func (lock *WorkerLock) reply(client *net.UnixConn) {
	defer lock.wait.Done()
	defer client.Close()
	if err := client.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		// ignore: a status reader may disconnect before the reply is written.
		return
	}
	if _, err := client.Write(lock.status()); err != nil {
		// ignore: a disconnected or stalled status reader does not release ownership.
		return
	}
}

// AssertOwned is passed to recovery and execution services. A released or failed
// listener cannot authorize work under the former process's state ownership.
func (lock *WorkerLock) AssertOwned() error {
	if lock == nil {
		return failure("worker_ownership_lost", "", nil)
	}
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.closed || lock.listener == nil {
		return failure("worker_ownership_lost", "", lock.failure)
	}
	return nil
}

// Close releases the socket after the caller has completed all worker cleanup.
// Repeated calls return the original close result.
func (lock *WorkerLock) Close() error {
	if lock == nil || lock.listener == nil {
		return failure("worker_ownership_lost", "", nil)
	}
	lock.once.Do(func() {
		lock.mu.Lock()
		lock.closed = true
		lock.mu.Unlock()
		err := lock.listener.Close()
		lock.wait.Wait()
		lock.mu.Lock()
		lock.closeErr = errors.Join(err, lock.failure)
		lock.mu.Unlock()
	})
	return lock.closeErr
}
