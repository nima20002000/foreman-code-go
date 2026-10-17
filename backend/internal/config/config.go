package config

import (
	"fmt"
	"math"
	"net"
	"strconv"
	"strings"
	"time"

	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

const maximumTimeoutMilliseconds = 2_147_483_647

// Database holds connection policy, not application domain data.
type Database struct {
	ConnectionString  string
	MaxConnections    int32
	ConnectionTimeout time.Duration
	QueryTimeout      time.Duration
	LockTimeout       time.Duration
}

// Config contains server infrastructure settings. Environment keeps canonical
// settings for the domain packages that own their validation and consumption.
type Config struct {
	Environment      Environment
	Host             string
	Port             int
	ReadinessTimeout time.Duration
	Database         Database
	BrowserOrigin    string
}

// Address returns the loopback listener address, including IPv6 brackets.
func (config Config) Address() string {
	return net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
}

// Load validates the infrastructure settings consumed by the server skeleton.
func Load(environment Environment) (Config, error) {
	resolved, err := Resolve(environment, nil)
	if err != nil {
		return Config{}, err
	}
	result := Config{Environment: resolved, Host: "127.0.0.1"}
	if host, exists := resolved["HOST"]; exists {
		result.Host = host
	}
	if !loopbackHost(result.Host) {
		return Config{}, &ValidationError{Setting: "HOST", Message: "The local app requires a loopback HOST: 127.0.0.1, ::1 or localhost."}
	}
	port, err := integer(resolved, "PORT", 3000, 65535)
	if err != nil {
		return Config{}, err
	}
	result.Port = int(port)
	result.Database, err = loadDatabase(resolved)
	if err != nil {
		return Config{}, err
	}
	readiness, err := integer(resolved, "READINESS_TIMEOUT_MS", 2000, maximumTimeoutMilliseconds)
	if err != nil {
		return Config{}, err
	}
	result.ReadinessTimeout = time.Duration(readiness) * time.Millisecond
	result.BrowserOrigin, err = browserOrigin(resolved)
	if err != nil {
		return Config{}, err
	}
	if value, exists := resolved["FOREMAN_CODE_LOCAL_PRODUCTION"]; exists && value != "0" && value != "1" {
		return Config{}, &ValidationError{Setting: "FOREMAN_CODE_LOCAL_PRODUCTION", Message: "FOREMAN_CODE_LOCAL_PRODUCTION must be 0 or 1."}
	}
	if resolved["FOREMAN_CODE_LOCAL_PRODUCTION"] == "1" {
		databaseURL, err := whatwgurl.Parse(result.Database.ConnectionString)
		if err != nil || !loopbackURLHost(databaseURL.Hostname()) {
			return Config{}, &ValidationError{Setting: "DATABASE_URL", Message: "Local production requires a loopback API and database."}
		}
	}
	return result, nil
}

func loadDatabase(environment Environment) (Database, error) {
	connectionString := environment["DATABASE_URL"]
	_, err := whatwgurl.Parse(connectionString)
	if err != nil || !strings.HasPrefix(connectionString, "postgresql://") {
		return Database{}, &ValidationError{Setting: "DATABASE_URL", Message: "DATABASE_URL must be a postgresql:// URL."}
	}
	maxConnections, err := integer(environment, "DATABASE_POOL_MAX", 10, math.MaxInt32)
	if err != nil {
		return Database{}, err
	}
	connectionTimeout, err := integer(environment, "DATABASE_CONNECTION_TIMEOUT_MS", 5000, maximumTimeoutMilliseconds)
	if err != nil {
		return Database{}, err
	}
	queryTimeout, err := integer(environment, "DATABASE_QUERY_TIMEOUT_MS", 1000, maximumTimeoutMilliseconds)
	if err != nil {
		return Database{}, err
	}
	return Database{
		ConnectionString:  connectionString,
		MaxConnections:    int32(maxConnections),
		ConnectionTimeout: time.Duration(connectionTimeout) * time.Millisecond,
		QueryTimeout:      time.Duration(queryTimeout) * time.Millisecond,
	}, nil
}

func integer(environment Environment, name string, fallback, maximum int64) (int64, error) {
	value, exists := environment[name]
	if !exists {
		return fallback, nil
	}
	parsed, finite := finiteNumber(trimSpace(value))
	if !finite || math.Trunc(parsed) != parsed || parsed < 1 || parsed > float64(maximum) {
		return 0, &ValidationError{Setting: name, Message: fmt.Sprintf("%s must be a positive integer at most %d.", name, maximum)}
	}
	return int64(parsed), nil
}

func loopbackHost(host string) bool {
	return host == "127.0.0.1" || host == "::1" || host == "localhost"
}
