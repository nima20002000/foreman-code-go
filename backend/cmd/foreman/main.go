package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/command"
	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
	"github.com/nima20002000/foreman-code-go/backend/internal/health"
	"github.com/nima20002000/foreman-code-go/backend/internal/logging"
	"github.com/nima20002000/foreman-code-go/backend/internal/schema"
)

func main() {
	os.Exit(execute())
}

func execute() (exitCode int) {
	logs := logging.New(logging.Options{Environment: config.FromEnviron(os.Environ()), Stdout: os.Stdout})
	defer func() {
		if err := logs.Close(); err != nil {
			// A failed destination cannot report its own failure through itself.
			// Preserve a prior command failure, and never claim a successful drain.
			if exitCode == 0 {
				exitCode = 1
			}
			if _, reportErr := fmt.Fprintln(os.Stderr, "Could not drain Foreman logs:", err); reportErr != nil {
				// Both destinations failed. The retained nonzero status is the
				// remaining process-level failure signal; do not recurse into logs.
				return
			}
		}
	}()
	logger := logs.Component("lifecycle")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	arguments := os.Args[1:]
	if len(arguments) == 1 && (arguments[0] == "--help" || arguments[0] == "-h" || arguments[0] == "help") {
		if _, err := fmt.Fprint(os.Stdout, command.Usage()); err != nil {
			logger.Error("write command help", "error", err)
			return 1
		}
		return 0
	}
	registry := command.Registry{
		command.Serve: func(ctx context.Context, arguments []string) error {
			return serve(ctx, arguments, logger)
		},
		// The worker owner supplies this handler when the worker runtime lands.
		command.Worker: func(context.Context, []string) error {
			return &command.UnavailableError{Command: command.Worker}
		},
	}
	err := command.Run(ctx, arguments, registry)
	if err == nil {
		return 0
	}
	logger.Error("foreman command failed", "error", err)
	var usage *command.UsageError
	if errors.As(err, &usage) {
		if _, writeErr := fmt.Fprint(os.Stderr, command.Usage()); writeErr != nil {
			logger.Error("write command usage", "error", writeErr)
		}
		return 2
	}
	return 1
}

func serve(ctx context.Context, arguments []string, logger *slog.Logger) error {
	if len(arguments) != 0 {
		return fmt.Errorf("serve takes its settings from the product environment and accepts no arguments")
	}
	environment, err := config.LoadEnvironment(config.FromEnviron(os.Environ()))
	if err != nil {
		return fmt.Errorf("load server environment: %w", err)
	}
	settings, err := config.Load(environment)
	if err != nil {
		return fmt.Errorf("load server settings: %w", err)
	}
	checkpointSchema := "langgraph"
	if value, exists := settings.Environment["LANGGRAPH_CHECKPOINT_SCHEMA"]; exists {
		checkpointSchema = strings.TrimSpace(value)
	}
	if err := prepareSchema(ctx, settings.Database, checkpointSchema, logger); err != nil {
		return err
	}
	db, err := database.Open(ctx, settings.Database, logger)
	if err != nil {
		return err
	}
	defer db.Close()
	application, err := app.New(app.Options{
		Config: settings, Database: db, Logger: logger,
		Readiness: app.Readiness{
			Database: db, Checkpoints: schema.CheckpointProbe(db, checkpointSchema),
		},
		ReadinessTimeout: settings.ReadinessTimeout,
	})
	if err != nil {
		return err
	}
	registerDomains(application)
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", settings.Address())
	if err != nil {
		return fmt.Errorf("listen for HTTP requests: %w", err)
	}
	logger.Info("Foreman API listening", "address", listener.Addr().String())
	return application.Serve(ctx, listener)
}

func prepareSchema(ctx context.Context, options config.Database, checkpointSchema string, logger *slog.Logger) error {
	// Migrations use their own bounded pool, as in the TS runtime. A request's
	// one-second SQL deadline must not limit a real captured baseline restore.
	options.MaxConnections = 1
	options.QueryTimeout = 30 * time.Minute
	options.LockTimeout = 5 * time.Second
	db, err := database.OpenPool(ctx, options, "graphql-migrations", logger)
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = database.RetryStartup(ctx, func(ctx context.Context) (struct{}, error) {
		return struct{}{}, schema.Prepare(ctx, db, checkpointSchema)
	}, database.RetryOptions{Logger: logger})
	if err != nil {
		return fmt.Errorf("prepare database schema: %w", err)
	}
	return nil
}

// Each lane adds one registration call here; its package owns its services and transports.
func registerDomains(application *app.App) {
	health.Register(application)
}
