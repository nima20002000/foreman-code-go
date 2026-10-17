//go:build integration

package testdb

import (
	"net"
	"net/url"
	"os"
	"strconv"
	"testing"
)

func providerURL(t *testing.T) *url.URL {
	t.Helper()
	value := os.Getenv("FOREMAN_CODE_CI_TEST_ADMIN_URL")
	if value == "" {
		t.Fatal("Integration tests require FOREMAN_CODE_CI_TEST_ADMIN_URL from Foreman CI's disposable database provider")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.ForceQuery ||
		(parsed.Scheme != "postgresql" && parsed.Scheme != "postgres") {
		t.Fatal("The disposable CI database URL must be a PostgreSQL URL without query parameters or fragments")
	}
	address := net.ParseIP(parsed.Hostname())
	if parsed.Hostname() != "localhost" && (address == nil || !address.IsLoopback()) {
		t.Fatal("The disposable CI database URL must use a loopback host")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		t.Fatal("The disposable CI database URL must have an explicit TCP port")
	}
	if parsed.Path == "" || parsed.Path == "/" || parsed.User == nil || parsed.User.Username() == "" {
		t.Fatal("The disposable CI database URL must explicitly select its database and user")
	}
	password, present := parsed.User.Password()
	if !present || password == "" {
		t.Fatal("The disposable CI database URL must explicitly include its password")
	}
	return parsed
}
