package config_test

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

func TestEnvironmentFileSelectionPreservesProcessPrecedence(t *testing.T) {
	for _, selector := range []string{"FOREMAN_CODE_API_ENV_FILE", "GRAPHQL_API_ENV_FILE"} {
		t.Run(selector, func(t *testing.T) {
			directory := t.TempDir()
			selected := filepath.Join(directory, "custom.env")
			contents := "FOREMAN_CODE_WEB_PORT=5199\nGRAPHQL_LAPTOP_EXECUTION_ENABLED=0\nDATABASE_URL=file-db\n"
			if err := os.WriteFile(selected, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			process := config.Environment{selector: selected, "GRAPHQL_WEB_PORT": "5198", "DATABASE_URL": "process-db"}
			resolved, err := config.ReadEnvironmentFile(process, filepath.Join(directory, "missing-default.env"))
			if err != nil {
				t.Fatal(err)
			}
			want := config.Environment{"FOREMAN_CODE_API_ENV_FILE": selected, "FOREMAN_CODE_WEB_PORT": "5198",
				"FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED": "0", "DATABASE_URL": "process-db"}
			if !reflect.DeepEqual(resolved, want) {
				t.Fatalf("Resolved environment = %#v, want %#v", resolved, want)
			}
			if process["GRAPHQL_WEB_PORT"] != "5198" || len(process) != 3 {
				t.Fatal("Loading an environment file modified the input process layer")
			}
		})
	}
}

func TestEnvironmentFileUsesTheSuppliedDefaultWhenNoSelectorExists(t *testing.T) {
	defaultFile := filepath.Join(t.TempDir(), "default.env")
	if err := os.WriteFile(defaultFile, []byte("GRAPHQL_WEB_PORT=5198\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := config.ReadEnvironmentFile(nil, defaultFile)
	if err != nil || resolved["FOREMAN_CODE_WEB_PORT"] != "5198" {
		t.Fatalf("The default file was not resolved: environment=%#v, error=%v", resolved, err)
	}
}

func TestEnvironmentFileConflictingSelectorsFailBeforeFileAccess(t *testing.T) {
	directory := t.TempDir()
	legacyFile := filepath.Join(directory, "legacy.env")
	process := config.Environment{"FOREMAN_CODE_API_ENV_FILE": filepath.Join(directory, "canonical.env"), "GRAPHQL_API_ENV_FILE": legacyFile}
	_, err := config.ReadEnvironmentFile(process, filepath.Join(directory, "default.env"))
	if err == nil || errors.Is(err, fs.ErrNotExist) || !strings.Contains(err.Error(), "conflicts with") {
		t.Fatalf("Expected the selector conflict before file access, got %v", err)
	}
	if len(process) != 2 || process["GRAPHQL_API_ENV_FILE"] != legacyFile {
		t.Fatal("Failed file selection modified the input environment")
	}
}

func TestStartupAllowsOnlyMissingEnvironmentFiles(t *testing.T) {
	directory := t.TempDir()
	process := config.Environment{"GRAPHQL_API_ENV_FILE": filepath.Join(directory, "missing.env"), "GRAPHQL_WEB_PORT": "5198"}
	if _, err := config.ReadEnvironmentFile(process, filepath.Join(directory, "default.env")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("The file reader did not preserve a missing-file error: %v", err)
	}
	resolved, err := config.LoadEnvironment(process)
	if err != nil || resolved["FOREMAN_CODE_WEB_PORT"] != "5198" {
		t.Fatalf("Startup did not preserve process settings without a file: environment=%#v, error=%v", resolved, err)
	}
	_, err = config.LoadEnvironment(config.Environment{"FOREMAN_CODE_API_ENV_FILE": directory})
	if err == nil || errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Startup must propagate a file-read error other than missing file: %v", err)
	}
}

func TestMissingEnvironmentFileDoesNotHideOtherAliasConflicts(t *testing.T) {
	_, err := config.LoadEnvironment(config.Environment{
		"FOREMAN_CODE_API_ENV_FILE": filepath.Join(t.TempDir(), "missing.env"),
		"FOREMAN_CODE_WEB_PORT": "5198", "GRAPHQL_WEB_PORT": "5199",
	})
	if err == nil || !strings.Contains(err.Error(), "FOREMAN_CODE_WEB_PORT conflicts with GRAPHQL_WEB_PORT") {
		t.Fatalf("A missing optional file hid conflicting process settings: %v", err)
	}
}

func TestEnvironmentFileDecodesMalformedUTF8WithoutDroppingTheBOM(t *testing.T) {
	selected := filepath.Join(t.TempDir(), "utf8.env")
	contents := []byte{0xef, 0xbb, 0xbf, 'A', '=', 'o', 'n', 'e', '\n', 'B', '=', 0xe1, 0x80, 'x', '\n'}
	if err := os.WriteFile(selected, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := config.ReadEnvironmentFile(nil, selected)
	if err != nil {
		t.Fatal(err)
	}
	want := config.Environment{"\uFEFFA": "one", "B": "\uFFFDx"}
	if !reflect.DeepEqual(resolved, want) {
		t.Fatalf("UTF-8 decoding = %#v, want %#v", resolved, want)
	}
}
