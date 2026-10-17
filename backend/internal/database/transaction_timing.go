package database

import (
	"context"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type transactionTiming struct {
	mu         sync.Mutex
	logger     *slog.Logger
	operation  string
	caller     string
	started    time.Time
	lastEnd    time.Time
	queryTime  time.Duration
	largestGap time.Duration
	statements int
	running    int
}

func newTransactionTiming(logger *slog.Logger, operation string) *transactionTiming {
	if operation != "graph.read" && operation != "graph.write" {
		operation = "transaction"
	}
	started := time.Now()
	return &transactionTiming{logger: logger, operation: operation, caller: transactionCaller(), started: started, lastEnd: started}
}

func (timing *transactionTiming) start() func() {
	started := time.Now()
	timing.mu.Lock()
	if timing.running == 0 {
		timing.largestGap = max(timing.largestGap, started.Sub(timing.lastEnd))
	}
	timing.running++
	timing.statements++
	timing.mu.Unlock()
	var settled sync.Once
	return func() {
		settled.Do(func() {
			timing.mu.Lock()
			defer timing.mu.Unlock()
			timing.running--
			timing.lastEnd = time.Now()
			timing.queryTime += timing.lastEnd.Sub(started)
		})
	}
}

func (timing *transactionTiming) finish(outcome string) {
	timing.mu.Lock()
	defer timing.mu.Unlock()
	timing.logger.Info("Database transaction statements", "component", "db",
		"metric", "db_transaction_statements", "operation", timing.operation,
		"outcome", outcome, "statements", timing.statements)
	finished := time.Now()
	total := finished.Sub(timing.started)
	if total <= time.Second {
		return
	}
	queryTime := min(timing.queryTime, total)
	timing.logger.Warn("Slow database transaction", "component", "db", "caller", timing.caller,
		"totalMs", total.Round(time.Millisecond).Milliseconds(),
		"queryMs", queryTime.Round(time.Millisecond).Milliseconds(),
		"betweenQueriesMs", (total-queryTime).Round(time.Millisecond).Milliseconds(),
		"queries", timing.statements,
		"largestGapMs", max(timing.largestGap, finished.Sub(timing.lastEnd)).Round(time.Millisecond).Milliseconds())
}

func transactionCaller() string {
	var programCounters [16]uintptr
	count := runtime.Callers(2, programCounters[:])
	frames := runtime.CallersFrames(programCounters[:count])
	var callers []string
	for {
		frame, more := frames.Next()
		if !strings.Contains(frame.Function, "/internal/database.") && !strings.HasPrefix(frame.Function, "runtime.") {
			callers = append(callers, frame.Function)
		}
		if !more || len(callers) == 3 {
			break
		}
	}
	return strings.Join(callers, " < ")
}

type timedQuerier struct {
	Querier
	timing *transactionTiming
}

func (query *timedQuerier) Exec(ctx context.Context, statement string, arguments ...any) (pgconn.CommandTag, error) {
	settle := query.timing.start()
	defer settle()
	return query.Querier.Exec(ctx, statement, arguments...)
}

func (query *timedQuerier) Query(ctx context.Context, statement string, arguments ...any) (pgx.Rows, error) {
	settle := query.timing.start()
	rows, err := query.Querier.Query(ctx, statement, arguments...)
	if err != nil {
		settle()
		return nil, err
	}
	return &timedRows{Rows: rows, settle: settle}, nil
}

func (query *timedQuerier) QueryRow(ctx context.Context, statement string, arguments ...any) pgx.Row {
	settle := query.timing.start()
	return &timedRow{Row: query.Querier.QueryRow(ctx, statement, arguments...), settle: settle}
}

type timedRows struct {
	pgx.Rows
	settle func()
}

func (rows *timedRows) Close() {
	rows.Rows.Close()
	rows.settle()
}

func (rows *timedRows) Next() bool {
	if rows.Rows.Next() {
		return true
	}
	rows.Close()
	return false
}

type timedRow struct {
	pgx.Row
	settle func()
}

func (row *timedRow) Scan(destinations ...any) error {
	defer row.settle()
	return row.Row.Scan(destinations...)
}
