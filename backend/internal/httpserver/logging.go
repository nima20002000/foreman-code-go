package httpserver

import (
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"
)

// RequestLogger emits the reference's one completion line with a query-free path.
// Now is an optional clock for a deterministic public timing boundary.
type RequestLogger struct {
	Logger *slog.Logger
	Now    func() time.Time
}

// Wrap leaves ResponseController operations available through Unwrap. Aborted or
// panicking requests propagate unchanged and do not emit a false completion line.
func (l RequestLogger) Wrap(next http.Handler) http.Handler {
	logger := l.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := l.Now
	if now == nil {
		now = time.Now
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := now()
		writer := &completionWriter{ResponseWriter: w}
		next.ServeHTTP(writer, r)
		elapsed := int64(math.Round(float64(now().Sub(started)) / float64(time.Millisecond)))
		status := writer.status
		if status == 0 {
			status = http.StatusOK
		}
		level := slog.LevelDebug
		switch {
		case status >= 500:
			level = slog.LevelError
		case elapsed >= 2000:
			level = slog.LevelWarn
		case status >= 400:
			level = slog.LevelInfo
		}
		path := r.RequestURI
		if path == "" {
			path = r.URL.RequestURI()
		}
		path, _, _ = strings.Cut(path, "?")
		logger.Log(r.Context(), level, "request completed", "component", "http",
			"reqId", RequestID(r.Context()), "method", r.Method, "path", path,
			"statusCode", status, "responseTimeMs", elapsed)
	})
}

type completionWriter struct {
	http.ResponseWriter
	status int
}

func (w *completionWriter) WriteHeader(status int) {
	if w.status == 0 && (status >= 200 || status == http.StatusSwitchingProtocols) {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *completionWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(data)
}

func (w *completionWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err == nil && w.status == 0 {
		w.status = http.StatusOK
	}
	return err
}

func (w *completionWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
