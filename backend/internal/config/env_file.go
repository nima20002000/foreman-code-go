package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"

	"golang.org/x/text/encoding/unicode"
)

// LoadEnvironment reads the selected API_ENV_FILE or .env and applies product
// aliases with process precedence. Only a missing file is optional at startup.
// It returns a copy and does not change the process environment.
func LoadEnvironment(process Environment) (Environment, error) {
	resolved, err := ReadEnvironmentFile(process, ".env")
	if errors.Is(err, fs.ErrNotExist) {
		return Resolve(process, nil)
	}
	return resolved, err
}

// ReadEnvironmentFile chooses API_ENV_FILE before touching the filesystem, then
// parses the file and resolves the process/file layers. Unlike LoadEnvironment,
// it returns missing-file errors; defaultFile is used exactly as supplied.
func ReadEnvironmentFile(process Environment, defaultFile string) (Environment, error) {
	selected, present, err := ReadProduct(process, "API_ENV_FILE")
	if err != nil {
		return nil, err
	}
	if !present {
		selected = defaultFile
	}
	contents, err := os.ReadFile(selected)
	if err != nil {
		return nil, err
	}
	// Node readFileSync(..., 'utf8') preserves a BOM and replaces malformed UTF-8
	// with U+FFFD. UTF8 (not UTF8BOM) provides the same decoding policy.
	decoded, err := unicode.UTF8.NewDecoder().Bytes(contents)
	if err != nil {
		return nil, fmt.Errorf("decode environment file: %w", err)
	}
	return Resolve(process, ParseEnv(string(decoded)))
}
