// Package logging owns the shared structured API logger and its ordered drains.
package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// LevelTrace and LevelFatal preserve the two reference levels beyond slog's four.
const (
	LevelTrace slog.Level = -8
	LevelFatal slog.Level = 12
)

// Options supplies startup environment and stdout without mutating process state.
// A nil Stdout uses os.Stdout. File-enabled logging is a separate adapter.
type Options struct {
	Environment map[string]string
	Stdout      io.Writer
}

// Runtime owns the logger's asynchronous resources. Close drains accepted lines
// without closing the caller's stdout. Its error must affect shutdown success.
type Runtime struct {
	Logger *slog.Logger
	stdout *bufferedWriter
}

// New creates the reference stdout logger without reading files or opening ports.
func New(options Options) *Runtime {
	destination := options.Stdout
	if destination == nil {
		destination = os.Stdout
	}
	stdout := newBufferedWriter(destination)
	level, silent := configuredLevel(options.Environment)
	inner := slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: level, ReplaceAttr: replaceBuiltins})
	logger := slog.New(&handler{inner: inner, silent: silent}).With("service", "graphql-api", "pid", os.Getpid())
	return &Runtime{Logger: logger, stdout: stdout}
}

// Component gives a shared subsystem a child of the one structured logger.
// Passive operational-failure aggregation is owned by its generated-contract adapter.
func (r *Runtime) Component(component string) *slog.Logger {
	return r.Logger.With("component", component)
}

// Fatal logs a final diagnostic and waits for all preceding accepted stdout lines.
// It does not exit the process; the composition root owns exit status and cleanup.
func (r *Runtime) Fatal(message string, arguments ...any) error {
	r.Logger.Log(context.Background(), LevelFatal, message, arguments...)
	return r.Flush()
}

func (r *Runtime) Flush() error { return r.stdout.Flush() }
func (r *Runtime) Close() error { return r.stdout.Close() }

func configuredLevel(environment map[string]string) (slog.Level, bool) {
	wanted := strings.TrimFunc(environment["LOG_LEVEL"], func(character rune) bool {
		return character >= '\t' && character <= '\r' ||
			character >= '\u2000' && character <= '\u200A' ||
			strings.ContainsRune(" \u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF", character)
	})
	// JavaScript lowercases U+0130 to i plus a combining dot, never plain i.
	// All supported level names are ASCII, so that expansion cannot match one.
	if strings.ContainsRune(wanted, '\u0130') {
		return slog.LevelInfo, environment["VITEST"] != ""
	}
	switch strings.ToLower(wanted) {
	case "trace":
		return LevelTrace, false
	case "debug":
		return slog.LevelDebug, false
	case "info":
		return slog.LevelInfo, false
	case "warn":
		return slog.LevelWarn, false
	case "error":
		return slog.LevelError, false
	case "fatal":
		return LevelFatal, false
	case "silent":
		return LevelFatal, true
	default:
		return slog.LevelInfo, environment["VITEST"] != ""
	}
}

func replaceBuiltins(_ []string, attribute slog.Attr) slog.Attr {
	switch attribute.Key {
	case slog.TimeKey:
		if attribute.Value.Kind() == slog.KindTime {
			return slog.String("time", attribute.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z"))
		}
	case slog.LevelKey:
		if level, ok := attribute.Value.Any().(slog.Level); ok {
			return slog.String("level", levelName(level))
		}
	case slog.MessageKey:
		attribute.Key = "msg"
	}
	return attribute
}

func levelName(level slog.Level) string {
	switch {
	case level >= LevelFatal:
		return "fatal"
	case level >= slog.LevelError:
		return "error"
	case level >= slog.LevelWarn:
		return "warn"
	case level >= slog.LevelInfo:
		return "info"
	case level >= slog.LevelDebug:
		return "debug"
	default:
		return "trace"
	}
}

type binding struct {
	groups     []string
	attributes []slog.Attr
}

type handler struct {
	inner    *slog.JSONHandler
	silent   bool
	groups   []string
	bindings []binding
}

func (h *handler) Enabled(ctx context.Context, level slog.Level) bool {
	return !h.silent && h.inner.Enabled(ctx, level)
}

func (h *handler) Handle(ctx context.Context, record slog.Record) error {
	if h.silent {
		return nil
	}
	var attributes []slog.Attr
	for _, bound := range h.bindings {
		attributes = appendGrouped(attributes, bound.groups, bound.attributes)
	}
	current := make([]slog.Attr, 0, record.NumAttrs())
	record.Attrs(func(attribute slog.Attr) bool {
		current = append(current, prepareAttribute(attribute, len(h.groups)))
		return true
	})
	attributes = appendGrouped(attributes, h.groups, current)
	next := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	next.AddAttrs(redactAttributes(attributes, 0)...)
	return h.inner.Handle(ctx, next)
}

func (h *handler) WithAttrs(attributes []slog.Attr) slog.Handler {
	copy := *h
	prepared := make([]slog.Attr, len(attributes))
	for index, attribute := range attributes {
		prepared[index] = prepareAttribute(attribute, len(h.groups))
	}
	copy.bindings = append(append([]binding(nil), h.bindings...), binding{
		groups: append([]string(nil), h.groups...), attributes: prepared,
	})
	return &copy
}

func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	copy := *h
	copy.groups = append(append([]string(nil), h.groups...), name)
	return &copy
}

func appendGrouped(attributes []slog.Attr, groups []string, additions []slog.Attr) []slog.Attr {
	if len(additions) == 0 {
		return attributes
	}
	if len(groups) == 0 {
		return append(attributes, additions...)
	}
	for index, attribute := range attributes {
		if attribute.Key == groups[0] && attribute.Value.Kind() == slog.KindGroup {
			children := append([]slog.Attr(nil), attribute.Value.Group()...)
			children = appendGrouped(children, groups[1:], additions)
			attributes[index].Value = slog.GroupValue(children...)
			return attributes
		}
	}
	children := appendGrouped(nil, groups[1:], additions)
	return append(attributes, slog.Attr{Key: groups[0], Value: slog.GroupValue(children...)})
}
