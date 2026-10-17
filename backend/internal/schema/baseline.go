// Package schema prepares a database from the captured TypeScript baseline and
// applies later, numbered Go migrations through the shared transaction helper.
package schema

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// SourceCommit is the frozen TypeScript source from which the dump must be made.
const SourceCommit = "8d2ea76c5028ef4458bf8cd64ef8624422e71d9f"

var (
	// ErrBaselineUnavailable means no actual, captured SQL baseline was supplied.
	ErrBaselineUnavailable = errors.New("the SQL baseline captured from a fresh TypeScript database is unavailable")
	// ErrIncompatible identifies a database outside the supported migration history.
	ErrIncompatible = errors.New("database schema does not match the TypeScript baseline or its Go migrations")
)

//go:embed assets
var assets embed.FS

type expectedHead struct {
	SourceCommit          string  `json:"sourceCommit"`
	ApplicationMigrations []int64 `json:"applicationMigrations"`
}

type migration struct {
	version  int64
	name     string
	checksum string
	sql      string
}

// Baseline holds a captured SQL dump and the expected application migration set.
// Its zero value cannot prepare a database; construct it with Read or Embedded.
type Baseline struct {
	head       expectedHead
	sql        string
	migrations []migration
}

// Embedded loads the captured baseline shipped in this binary.
func Embedded() (*Baseline, error) {
	files, err := fs.Sub(assets, "assets")
	if err != nil {
		return nil, fmt.Errorf("open embedded schema assets: %w", err)
	}
	return Read(files)
}

// Read loads expected-head.json, an optional captured baseline.sql, and later
// migrations/*.sql. Without the dump, only an already-current DB can be accepted.
// It never derives SQL from the TypeScript migrations.
func Read(files fs.FS) (*Baseline, error) {
	data, err := fs.ReadFile(files, "expected-head.json")
	if err != nil {
		return nil, fmt.Errorf("read expected TypeScript head: %w", err)
	}
	var head expectedHead
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("decode expected TypeScript head: %w", err)
	}
	if head.SourceCommit != SourceCommit {
		return nil, fmt.Errorf("schema source commit is %q; expected %s", head.SourceCommit, SourceCommit)
	}
	if err := validateVersions(head.ApplicationMigrations); err != nil {
		return nil, err
	}
	baseline := &Baseline{head: head}
	sql, err := fs.ReadFile(files, "baseline.sql")
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("read captured SQL baseline: %w", err)
	}
	if err == nil {
		if strings.TrimSpace(string(sql)) == "" {
			return nil, fmt.Errorf("%w: the captured dump is empty", ErrBaselineUnavailable)
		}
		baseline.sql = string(sql)
	}
	if err := baseline.readMigrations(files); err != nil {
		return nil, err
	}
	return baseline, nil
}

func validateVersions(versions []int64) error {
	if len(versions) == 0 {
		return errors.New("expected TypeScript migration history is empty")
	}
	for i, version := range versions {
		if version < 1 || (i > 0 && version <= versions[i-1]) {
			return errors.New("expected TypeScript migration versions must be positive, unique, and sorted")
		}
	}
	return nil
}

var migrationName = regexp.MustCompile(`^([0-9]+)_[a-z0-9_]+\.sql$`)

func (b *Baseline) readMigrations(files fs.FS) error {
	entries, err := fs.ReadDir(files, "migrations")
	if errors.Is(err, fs.ErrNotExist) {
		return nil // No later Go migrations exist yet.
	}
	if err != nil {
		return fmt.Errorf("read numbered schema migrations: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || path.Ext(entry.Name()) != ".sql" {
			continue
		}
		match := migrationName.FindStringSubmatch(entry.Name())
		if match == nil {
			return fmt.Errorf("invalid numbered schema migration name %q", entry.Name())
		}
		version, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil || version < 1 {
			return fmt.Errorf("schema migration %q requires a positive integer version", entry.Name())
		}
		sql, err := fs.ReadFile(files, path.Join("migrations", entry.Name()))
		if err != nil {
			return fmt.Errorf("read schema migration %q: %w", entry.Name(), err)
		}
		if strings.TrimSpace(string(sql)) == "" {
			return fmt.Errorf("schema migration %q is empty", entry.Name())
		}
		b.migrations = append(b.migrations, newMigration(version, entry.Name(), sql))
	}
	slices.SortFunc(b.migrations, func(a, c migration) int {
		if a.version < c.version {
			return -1
		}
		if a.version > c.version {
			return 1
		}
		return 0
	})
	for i := 1; i < len(b.migrations); i++ {
		if b.migrations[i-1].version == b.migrations[i].version {
			return fmt.Errorf("duplicate schema migration version %d", b.migrations[i].version)
		}
	}
	return nil
}

func newMigration(version int64, name string, sql []byte) migration {
	sum := sha256.Sum256(sql)
	return migration{version: version, name: name, checksum: hex.EncodeToString(sum[:]), sql: string(sql)}
}

// CheckHead accepts exactly the full TS migration set, including every gap.
// Checking only the maximum would accept a partially migrated database.
func (b *Baseline) CheckHead(applied []int64) error {
	if len(b.head.ApplicationMigrations) == 0 {
		return ErrBaselineUnavailable
	}
	versions := slices.Clone(applied)
	slices.Sort(versions)
	if !slices.Equal(versions, b.head.ApplicationMigrations) {
		return fmt.Errorf("%w: application_migrations differs from source %s", ErrIncompatible, b.head.SourceCommit)
	}
	return nil
}
