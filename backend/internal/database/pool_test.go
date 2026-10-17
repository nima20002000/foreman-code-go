package database_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
	"github.com/nima20002000/foreman-code-go/backend/internal/database"
)

func TestPoolConfigurationKeepsTheDatabaseTimeoutPolicy(t *testing.T) {
	isolatePostgreSQLEnvironment(t)
	options := config.Database{ConnectionString: "postgresql://127.0.0.1/example", MaxConnections: 10,
		ConnectionTimeout: 5 * time.Second, QueryTimeout: time.Second}
	configured, err := database.PoolConfig(options, "graphql-api")
	if err != nil {
		t.Fatal(err)
	}
	if configured.ConnConfig.ConnectTimeout != time.Second || configured.MaxConns != 10 ||
		configured.MinConns != 4 || configured.MaxConnIdleTime != time.Minute || configured.MaxConnLifetime != 0 {
		t.Fatal("The pool did not retain the acquisition, idle, or sizing policy")
	}
	if configured.ConnConfig.RuntimeParams["statement_timeout"] != "1000" ||
		configured.ConnConfig.RuntimeParams["application_name"] != "graphql-api" {
		t.Fatal("The pool did not apply its server deadline and application name")
	}
}

func TestMigrationPoolUsesItsLongerDDLAndLockTimeouts(t *testing.T) {
	isolatePostgreSQLEnvironment(t)
	options := config.Database{ConnectionString: "postgresql://127.0.0.1/example", MaxConnections: 1,
		ConnectionTimeout: 5 * time.Second, QueryTimeout: 30 * time.Minute, LockTimeout: 5 * time.Second}
	configured, err := database.PoolConfig(options, "graphql-migrations")
	if err != nil {
		t.Fatal(err)
	}
	if configured.MaxConns != 1 || configured.MinConns != 1 ||
		configured.ConnConfig.RuntimeParams["statement_timeout"] != "1800000" ||
		configured.ConnConfig.RuntimeParams["lock_timeout"] != "5000" {
		t.Fatal("The migration pool lost its dedicated sizing or DDL policy")
	}
}

func TestPoolConfigurationFailsBeforeOpeningAnInvalidConnection(t *testing.T) {
	isolatePostgreSQLEnvironment(t)
	_, err := database.PoolConfig(config.Database{ConnectionString: "postgresql://127.0.0.1/example",
		MaxConnections: 0, ConnectionTimeout: time.Second, QueryTimeout: time.Second}, "invalid")
	if err == nil {
		t.Fatal("A zero-sized pool must be rejected before a connection is opened")
	}
}

func isolatePostgreSQLEnvironment(t *testing.T) {
	t.Helper()
	directory := t.TempDir()
	for _, variable := range os.Environ() {
		name, _, _ := strings.Cut(variable, "=")
		if strings.HasPrefix(name, "PG") {
			t.Setenv(name, "")
		}
	}
	for _, name := range []string{"HOME", "USERPROFILE", "APPDATA"} {
		t.Setenv(name, directory)
	}
	// pgx parses these files before a connection is opened. Keep both explicit
	// paths and platform-specific home defaults inside this test's directory.
	t.Setenv("PGPASSFILE", filepath.Join(directory, "pgpass"))
	t.Setenv("PGSERVICEFILE", filepath.Join(directory, "pg-service.conf"))
	t.Setenv("PGUSER", "foreman_test")
}
