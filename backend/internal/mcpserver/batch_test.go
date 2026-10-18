package mcpserver_test

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// Frozen server 2.0 accepts request arrays even at the existing 2025-11-25
// revision. The pinned Go SDK rejects them before dispatch. Keep this public
// regression independent of the single-ID response repair; an older revision
// header is not an authorized way to make it pass.
func TestMCPFrozenBatchBoundary(t *testing.T) {
	for _, test := range []struct { name string; ids []string }{
		{"typed_ids", []string{`7`, `"7"`}},
		{"lossy_collision", []string{`"\ud800"`, `"�"`, `"\udc00"`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newCancellationFixture(t, nil)
			requests := make([]string, len(test.ids))
			for index, id := range test.ids {
				requests[index] = `{"jsonrpc":"2.0","id":`+id+`,"method":"tools/call","params":{"name":"fixture_wait","arguments":{"label":"batch-fixture"}}}`
			}
			ctx, cancel := context.WithTimeout(context.Background(), cancellationWait)
			defer cancel()
			reply := fixture.post(ctx, "caller-a", "["+strings.Join(requests, ",")+"]")
			if reply.err != nil { t.Fatalf("unmet public HTTP setup: %v", reply.err) }
			if reply.status != 200 || fixture.invocations.Load() != int32(len(test.ids)) {
				t.Fatalf("frozen batch request did not dispatch all source-admitted public tools: status=%d invoked=%d want=%d body=%s", reply.status, fixture.invocations.Load(), len(test.ids), reply.body)
			}
			if !strings.HasPrefix(reply.header.Get("Content-Type"), "text/event-stream") { t.Fatal("default frozen batch mode did not produce SSE") }
			seen := make(map[string]int)
			scanner := bufio.NewScanner(strings.NewReader(string(reply.body)))
			for scanner.Scan() {
				line, data := strings.CutPrefix(scanner.Text(), "data: ")
				if !data { continue }
				var response map[string]json.RawMessage
				if err := json.Unmarshal([]byte(line), &response); err != nil { t.Fatal(err) }
				if _, result := response["result"]; !result { t.Fatalf("batch tool response has no result: %s", line) }
				seen[string(response["id"])]++
			}
			if err := scanner.Err(); err != nil { t.Fatal(err) }
			for _, id := range test.ids {
				if seen[id] != 1 { t.Fatalf("batch response lost typed/lossless ID %s: counts=%v", id, seen) }
			}
			if len(seen) != len(test.ids) { t.Fatalf("batch gained a response ID: %v", seen) }
		})
	}
}
