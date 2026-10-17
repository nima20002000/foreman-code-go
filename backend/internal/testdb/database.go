//go:build integration

// Package testdb provides fresh PostgreSQL databases from Foreman CI's disposable
// database provider. It is available only to integration-tagged test builds.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

// Fixture owns one database created exclusively for the current test.
// Register pool.Close cleanups after New so they run before database removal.
type Fixture struct {
	dsn string
}

// New requires Foreman CI's explicit disposable database URL. It never falls
// back to application settings and fails when the CI resource is unavailable.
func New(t *testing.T) *Fixture {
	t.Helper()
	provider := providerURL(t)
	settings, err := pgx.ParseConfig(provider.String())
	if err != nil {
		t.Fatalf("Parse the disposable CI database configuration failed (%s)", databaseFailure(err))
	}
	settings.ConnectTimeout = 5 * time.Second
	settings.RuntimeParams["statement_timeout"] = "30000"
	settings.RuntimeParams["lock_timeout"] = "5000"

	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	admin, err := pgx.ConnectConfig(ctx, settings)
	if err != nil {
		t.Fatalf("Connect to the disposable CI database failed (%s)", databaseFailure(err))
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := admin.Close(cleanup); err != nil {
			t.Errorf("Close the disposable CI admin connection failed (%s)", databaseFailure(err))
		}
	})

	var identity [16]byte
	if _, err := rand.Read(identity[:]); err != nil {
		t.Fatalf("Create a unique integration database name failed (%T)", err)
	}
	name := "foreman_test_" + hex.EncodeToString(identity[:])
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "create database "+identifier+" template template0 encoding 'UTF8'"); err != nil {
		t.Fatalf("Create the fresh integration database failed (%s)", databaseFailure(err))
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "drop database "+identifier); err != nil {
			t.Errorf("Remove the owned integration database failed (%s)", databaseFailure(err))
		}
	})

	provider.Path = "/" + name
	provider.RawPath = ""
	return &Fixture{dsn: provider.String()}
}

// Config returns connection policy for this fixture. Callers may adjust their
// returned copy for a dedicated migration or application pool.
func (fixture *Fixture) Config() config.Database {
	return config.Database{
		ConnectionString:  fixture.dsn,
		MaxConnections:    1,
		ConnectionTimeout: 5 * time.Second,
		QueryTimeout:      5 * time.Second,
	}
}

// DSN returns the owned database's connection string. It must not be logged.
func (fixture *Fixture) DSN() string { return fixture.dsn }

func databaseFailure(err error) string {
	var postgres *pgconn.PgError
	if errors.As(err, &postgres) {
		return "PostgreSQL SQLSTATE " + postgres.Code
	}
	return fmt.Sprintf("%T", err)
}
