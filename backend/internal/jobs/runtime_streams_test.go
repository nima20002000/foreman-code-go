package jobs_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/jobs"
)

type observedRuntimeReader struct {
	io.Reader
	closed atomic.Bool
}

func (reader *observedRuntimeReader) Close() error {
	reader.closed.Store(true)
	return nil
}

func TestRuntimeCommandClosesAvailableStreamWhenPeerMissing(t *testing.T) {
	for _, missing := range []string{"stdout", "stderr"} {
		t.Run(missing, func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
				return runner.Run(context.Background(), []string{"inspect"})
			})
			launch := receiveRuntimeValue(t, port.launches)
			process := runtimeProcess("incomplete-streams", "", "")
			available := &observedRuntimeReader{Reader: strings.NewReader("remaining native stream")}
			if missing == "stdout" {
				process.stdout, process.stderr = nil, available
			} else {
				process.stdout, process.stderr = available, nil
			}
			launch.reply <- runtimeLaunchResponse{process: process}
			closing := receiveRuntimeValue(t, port.closes)
			if closing.id != process.id {
				t.Fatalf("wrong original launch closed: %q", closing.id)
			}
			select {
			case value := <-result:
				t.Fatalf("incomplete launch returned before original closure: %+v", value)
			default:
			}
			closing.reply <- nil
			value := receiveRuntimeValue(t, result)
			if !errors.Is(value.err, jobs.ErrRuntimeLaunchUnavailable) || !available.closed.Load() {
				t.Fatalf("incomplete launch error = %v, available stream closed = %t", value.err, available.closed.Load())
			}
		})
	}
}

type nativeChunkReader struct {
	chunks [][]byte
}

func (reader *nativeChunkReader) Read(buffer []byte) (int, error) {
	if len(reader.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := reader.chunks[0]
	if len(buffer) < len(chunk) {
		return 0, io.ErrShortBuffer
	}
	reader.chunks = reader.chunks[1:]
	return copy(buffer, chunk), nil
}

func TestRuntimeCommandPreservesNativeChunkUTF8Replacement(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		chunks [][]byte
		want   string
	}{
		{"separate invalid bytes", [][]byte{{0xff, 0xfe}}, "\uFFFD\uFFFD"},
		{"truncated sequence", [][]byte{{0xe2, 0x82}}, "\uFFFD"},
		{"invalid continuation", [][]byte{{0xe2, 0x82, 'x'}}, "\uFFFDx"},
		{"per native chunk", [][]byte{{0xe2}, {0x82, 0xac}}, "\uFFFD\uFFFD\uFFFD"},
		{"complete unicode", [][]byte{[]byte("€é")}, "€é"},
		{"preserved BOM", [][]byte{{0xef, 0xbb, 0xbf, 'x'}}, "\uFEFFx"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			port := newGuardedRuntime(t)
			runner := jobs.NewRuntimeCommandRunner(port)
			result := startRuntimeCommand(func() (jobs.RuntimeCommandResult, error) {
				return runner.Run(context.Background(), []string{"inspect"})
			})
			launch := receiveRuntimeValue(t, port.launches)
			process := runtimeProcess("native-chunk-decoding", "", "")
			process.stdout = io.NopCloser(&nativeChunkReader{chunks: fixture.chunks})
			code := 0
			process.exit <- fakeNativeExit{code: &code}
			launch.reply <- runtimeLaunchResponse{process: process}
			confirmRuntimeClosure(t, port, process.id, nil)
			value := receiveRuntimeValue(t, result)
			if value.err != nil || value.value.Stdout != fixture.want {
				t.Fatalf("native chunk text = %q, want %q, err = %v", value.value.Stdout, fixture.want, value.err)
			}
		})
	}
}
