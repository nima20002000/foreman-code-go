package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

type backgroundService struct {
	name string
	run  func(context.Context) error
}

type serviceResult struct {
	name                 string
	err                  error
	http                 bool
	shutdownCancellation bool
}

// RegisterService attaches background work to the app lifetime. The service must stop on cancellation.
// Register during composition; a returned failure stops the app and remains visible to its caller.
func (a *App) RegisterService(name string, run func(context.Context) error) {
	if name == "" || run == nil {
		panic("background service registration requires a name and function")
	}
	for _, service := range a.services {
		if service.name == name {
			panic(fmt.Sprintf("background service %q is already registered", name))
		}
	}
	a.services = append(a.services, backgroundService{name: name, run: run})
}

// Serve serves an already-created listener, starts registered services and drains on cancellation.
// The caller retains ownership of database and other infrastructure cleanup.
func (a *App) Serve(ctx context.Context, listener net.Listener) error {
	if listener == nil {
		return fmt.Errorf("HTTP listener is required")
	}
	serviceContext, cancelServices := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelServices()
	unused := newConnections(a.Logger)
	server := &http.Server{Handler: a.Handler(), ConnState: unused.observe}
	results := make(chan serviceResult, len(a.services)+1)
	go func() { results <- serviceResult{name: "http", err: server.Serve(listener), http: true} }()
	for _, service := range a.services {
		go func() {
			err := service.run(serviceContext)
			// Record the service's own cancellation state before the result can queue during HTTP drain.
			results <- serviceResult{name: service.name, err: err,
				shutdownCancellation: serviceContext.Err() != nil && onlyExpectedError(err, context.Canceled)}
		}()
	}
	remaining := len(a.services) + 1
	remaining, failure := awaitStop(ctx, results, remaining)
	failure = errors.Join(failure, unused.close())
	shutdownContext, cancelShutdown := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancelShutdown()
	shutdownError := server.Shutdown(shutdownContext)
	if shutdownError != nil {
		shutdownError = errors.Join(shutdownError, server.Close())
	}
	cancelServices()
	for remaining > 0 {
		select {
		case result := <-results:
			remaining--
			failure = errors.Join(failure, stoppedServiceError(result))
		case <-shutdownContext.Done():
			return errors.Join(failure, shutdownError, fmt.Errorf("background shutdown incomplete: %w", shutdownContext.Err()))
		}
	}
	return errors.Join(failure, shutdownError)
}

func awaitStop(ctx context.Context, results <-chan serviceResult, remaining int) (int, error) {
	for remaining > 0 {
		select {
		case <-ctx.Done():
			return remaining, nil
		case result := <-results:
			remaining--
			if failure := stoppedServiceError(result); failure != nil {
				return remaining, failure
			}
			if result.http {
				return remaining, nil
			}
		}
	}
	return remaining, nil
}

func stoppedServiceError(result serviceResult) error {
	if result.err == nil || result.http && onlyExpectedError(result.err, http.ErrServerClosed) || result.shutdownCancellation {
		return nil
	}
	return fmt.Errorf("%s service: %w", result.name, result.err)
}

// onlyExpectedError accepts wrappers and joins only when every leaf is the expected shutdown error.
func onlyExpectedError(err, expected error) bool {
	if err == expected {
		return true
	}
	switch wrapped := err.(type) {
	case interface{ Unwrap() []error }:
		causes := wrapped.Unwrap()
		for _, cause := range causes {
			if !onlyExpectedError(cause, expected) {
				return false
			}
		}
		return len(causes) > 0
	case interface{ Unwrap() error }:
		return onlyExpectedError(wrapped.Unwrap(), expected)
	default:
		return false
	}
}
