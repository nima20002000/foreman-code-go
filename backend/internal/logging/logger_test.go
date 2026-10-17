package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/logging"
)

func readLines(t *testing.T, data []byte) []map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var lines []map[string]any
	for {
		var line map[string]any
		err := decoder.Decode(&line)
		if errors.Is(err, io.EOF) {
			return lines
		}
		if err != nil {
			t.Fatalf("decode structured log: %v", err)
		}
		lines = append(lines, line)
	}
}

func runtimeFor(t *testing.T, environment map[string]string) (*logging.Runtime, *bytes.Buffer) {
	t.Helper()
	var output bytes.Buffer
	runtime := logging.New(logging.Options{Environment: environment, Stdout: &output})
	t.Cleanup(func() {
		if err := runtime.Close(); err != nil {
			t.Errorf("close logger: %v", err)
		}
	})
	return runtime, &output
}

func TestLoggingStructuredStdout(t *testing.T) {
	runtime, output := runtimeFor(t, nil)
	runtime.Component("database").Info("query completed", "operation", "load graph", "count", 3)
	if err := runtime.Flush(); err != nil {
		t.Fatal(err)
	}
	lines := readLines(t, output.Bytes())
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want one", len(lines))
	}
	line := lines[0]
	for key, want := range map[string]any{"service": "graphql-api", "component": "database",
		"level": "info", "msg": "query completed", "operation": "load graph",
		"count": json.Number("3"), "pid": json.Number(fmt.Sprint(os.Getpid()))} {
		if line[key] != want {
			t.Errorf("%s = %#v, want %#v", key, line[key], want)
		}
	}
	stamp, ok := line["time"].(string)
	if !ok {
		t.Fatalf("time = %#v", line["time"])
	}
	if parsed, err := time.Parse("2006-01-02T15:04:05.000Z", stamp); err != nil || parsed.IsZero() {
		t.Fatalf("time = %q, parse error = %v", stamp, err)
	}
}

func TestLoggingLevelEnvironment(t *testing.T) {
	for _, test := range []struct {
		name        string
		environment map[string]string
		want        string
	}{
		{"default", nil, "info,warn,error,fatal"},
		{"trace", map[string]string{"LOG_LEVEL": " \tTRACE\u00a0"}, "trace,debug,info,warn,error,fatal"},
		{"debug", map[string]string{"LOG_LEVEL": "debug"}, "debug,info,warn,error,fatal"},
		{"warn", map[string]string{"LOG_LEVEL": "warn"}, "warn,error,fatal"},
		{"error", map[string]string{"LOG_LEVEL": "error"}, "error,fatal"},
		{"fatal", map[string]string{"LOG_LEVEL": "fatal"}, "fatal"},
		{"silent", map[string]string{"LOG_LEVEL": "silent"}, ""},
		{"vitest", map[string]string{"VITEST": "false"}, ""},
		{"explicit_beats_vitest", map[string]string{"VITEST": "1", "LOG_LEVEL": "info"}, "info,warn,error,fatal"},
		{"invalid", map[string]string{"LOG_LEVEL": "verbose"}, "info,warn,error,fatal"},
		{"bom_trim", map[string]string{"LOG_LEVEL": "\ufeffdebug\ufeff"}, "debug,info,warn,error,fatal"},
		{"nel_is_not_trimmed", map[string]string{"LOG_LEVEL": "\u0085debug\u0085"}, "info,warn,error,fatal"},
		{"expanding_lowercase", map[string]string{"LOG_LEVEL": "\u0130NFO", "VITEST": "1"}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			runtime, output := runtimeFor(t, test.environment)
			for _, level := range []slog.Level{logging.LevelTrace, slog.LevelDebug, slog.LevelInfo,
				slog.LevelWarn, slog.LevelError, logging.LevelFatal} {
				runtime.Logger.Log(context.Background(), level, "level probe")
			}
			if err := runtime.Flush(); err != nil {
				t.Fatal(err)
			}
			var levels []string
			for _, line := range readLines(t, output.Bytes()) {
				levels = append(levels, line["level"].(string))
			}
			if got := strings.Join(levels, ","); got != test.want {
				t.Fatalf("levels = %q, want %q", got, test.want)
			}
		})
	}
}

func TestLoggingRedactsSourcePaths(t *testing.T) {
	runtime, output := runtimeFor(t, nil)
	keys := []string{"authorization", "cookie", "set-cookie", "token", "accessToken", "refreshToken",
		"apiKey", "api_key", "password", "secret", "credential", "connectionString", "prompt",
		"initialPrompt", "input", "output", "env", "environment"}
	for _, key := range keys {
		runtime.Logger.Info("redaction probe", key, "private", "first", map[string]any{key: "private"},
			"outer", map[string]any{"second": map[string]any{key: "private"}},
			"array", []any{map[string]any{key: "private"}})
	}
	runtime.Logger.Info("request probe", "req", map[string]any{"headers": map[string]any{"authorization": "private", "cookie": "private"}},
		"res", map[string]any{"headers": map[string]any{"set-cookie": "private"}})
	if err := runtime.Flush(); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output.Bytes(), []byte("private")) {
		t.Fatalf("a configured source redaction path leaked: %s", output.Bytes())
	}
	lines := readLines(t, output.Bytes())
	if len(lines) != len(keys)+1 {
		t.Fatalf("got %d lines", len(lines))
	}
	for index, key := range keys {
		line := lines[index]
		if line[key] != "[redacted]" || line["first"].(map[string]any)[key] != "[redacted]" ||
			line["outer"].(map[string]any)["second"].(map[string]any)[key] != "[redacted]" ||
			line["array"].([]any)[0].(map[string]any)[key] != "[redacted]" {
			t.Fatalf("configured path did not retain its censor for %s", key)
		}
	}
}

func TestLoggingGroupsAndBindingsRetainRedaction(t *testing.T) {
	runtime, output := runtimeFor(t, nil)
	bound := map[string]any{"token": "private", "safe": "original"}
	child := runtime.Logger.With("binding", bound).WithGroup("request").With("cookie", "private")
	bound["safe"] = "mutated"
	child.Info("group probe", slog.Group("headers", slog.String("authorization", "private")),
		slog.Group("", slog.String("password", "private")), slog.Group("token", slog.String("nested", "private")))
	runtime.Logger.WithGroup("token").Info("secret group", "value", "private")
	if err := runtime.Flush(); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output.Bytes(), []byte("private")) {
		t.Fatalf("group redaction leaked: %s", output.Bytes())
	}
	lines := readLines(t, output.Bytes())
	if len(lines) != 2 {
		t.Fatalf("got %d lines", len(lines))
	}
	if got := lines[0]["binding"].(map[string]any)["safe"]; got != "original" {
		t.Fatalf("bound value changed after With: %v", got)
	}
	request := lines[0]["request"].(map[string]any)
	if request["cookie"] != "[redacted]" || request["password"] != "[redacted]" || request["token"] != "[redacted]" ||
		request["headers"].(map[string]any)["authorization"] != "[redacted]" || lines[1]["token"] != "[redacted]" {
		t.Fatalf("group fields did not retain source redaction semantics")
	}
}

type codedError struct {
	Name  string
	Stack string
	Cause error
}

func (err *codedError) Error() string       { return "database unavailable" }
func (err *codedError) FailureCode() string { return "DATABASE_CONNECTION_FAILED" }
func (err *codedError) Unwrap() error       { return err.Cause }

func TestLoggingSerializesBoundedErrorIdentity(t *testing.T) {
	runtime, output := runtimeFor(t, nil)
	err := &codedError{Name: "DatabaseError", Stack: "retained stack", Cause: errors.New("socket reset")}
	runtime.Logger.Error("request failed", "err", err)
	runtime.Logger.Error("group error", slog.Group("error", "name", "InputError", "message", "invalid input", "code", 400))
	var absent *codedError
	runtime.Logger.Info("nil error", "error", absent, "optional", absent)
	if flushErr := runtime.Flush(); flushErr != nil {
		t.Fatal(flushErr)
	}
	lines := readLines(t, output.Bytes())
	if len(lines) != 3 {
		t.Fatalf("got %d lines", len(lines))
	}
	serialized := lines[0]["err"].(map[string]any)
	for key, want := range map[string]any{"type": "DatabaseError", "message": "database unavailable",
		"stack": "retained stack", "code": "DATABASE_CONNECTION_FAILED"} {
		if serialized[key] != want {
			t.Errorf("%s = %#v, want %#v", key, serialized[key], want)
		}
	}
	if serialized["cause"].(map[string]any)["message"] != "socket reset" {
		t.Fatal("wrapped error cause was lost")
	}
	group := lines[1]["error"].(map[string]any)
	if group["type"] != "InputError" || group["message"] != "invalid input" || group["code"] != json.Number("400") {
		t.Fatalf("group error = %#v", group)
	}
	if lines[2]["error"].(map[string]any)["message"] != "null" || lines[2]["optional"] != nil {
		t.Fatalf("nil error = %#v", lines[2])
	}
}

func TestLoggingBoundsCyclesDepthAndAggregateErrors(t *testing.T) {
	cyclic := map[string]any{"name": "CycleError", "message": "outer"}
	cyclic["cause"] = cyclic
	serialized := logging.SerializeError(cyclic)
	if serialized["cause"].(map[string]any)["message"] != "Repeated or truncated error cause." {
		t.Fatal("repeated object was not bounded")
	}
	var cause error = errors.New("root")
	for index := 0; index < 12; index++ {
		cause = fmt.Errorf("layer %d: %w", index, cause)
	}
	current := logging.SerializeError(cause)
	for depth := 0; depth < 8; depth++ {
		if _, present := current["type"]; !present {
			t.Fatalf("cause was truncated early at %d", depth)
		}
		current = current["cause"].(map[string]any)
	}
	if current["message"] != "Repeated or truncated error cause." {
		t.Fatal("deep cause was not bounded at eight objects")
	}
	causes := make([]error, 10)
	for index := range causes {
		causes[index] = fmt.Errorf("cause %d", index)
	}
	aggregate := logging.SerializeError(errors.Join(causes...))
	children := aggregate["errors"].([]map[string]any)
	if aggregate["type"] != "AggregateError" || len(children) != 8 || children[7]["message"] != "cause 7" {
		t.Fatalf("aggregate = %#v", aggregate)
	}
	var many error = errors.New("last")
	for index := 0; index < 5; index++ {
		many = errors.Join(errors.New("a"), errors.New("b"), errors.New("c"), errors.New("d"),
			errors.New("e"), errors.New("f"), errors.New("g"), many)
	}
	result := logging.SerializeError(many)
	encoded, err := json.Marshal(result)
	if err != nil || !bytes.Contains(encoded, []byte("Repeated or truncated error cause.")) {
		t.Fatalf("aggregate object limit missing: %s, %v", encoded, err)
	}
}

func TestLoggingKeepsSourceRedactionDepth(t *testing.T) {
	runtime, output := runtimeFor(t, nil)
	runtime.Logger.Info("depth probe", "one", map[string]any{"two": map[string]any{"three": map[string]any{"token": "outside-source-paths"}}})
	if err := runtime.Flush(); err != nil {
		t.Fatal(err)
	}
	line := readLines(t, output.Bytes())[0]
	if got := line["one"].(map[string]any)["two"].(map[string]any)["three"].(map[string]any)["token"]; got != "outside-source-paths" {
		t.Fatalf("source redaction depth changed: %v", got)
	}
}
