package mcpserver

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"unicode/utf16"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// ResponseIDWriter restores only the request's lossless string ID at the
// pinned SDK's response serialization boundary. It accepts one JSON body or a
// sequence of SSE events. It does not rewrite requests, notifications, payloads,
// arbitrary matching text, another response's ID, or a source null error ID.
// Calls are serialized like the underlying http.ResponseWriter. Call Finish
// after the SDK handler returns, including when it ignores a flush error.
type ResponseIDWriter struct {
	writer       http.ResponseWriter
	sdkID        jsonvalue.UTF16String
	encodedID    []byte
	restore      bool
	committed    bool
	finished     bool
	mode         byte
	pending      []byte
	scan         int
	lineStart    int
	jsonDepth    int
	jsonStarted  bool
	jsonQuoted   bool
	jsonEscape   bool
	failure      error
}

const (
	responsePass byte = iota
	responseJSON
	responseSSE
)

// NewResponseIDWriter takes the original admitted UTF-16 string ID, not a
// replacement-decoded display string. Well-formed IDs use a byte-preserving
// pass-through. Empty is a valid string ID. This adds no frame or queue limit.
func NewResponseIDWriter(writer http.ResponseWriter, original jsonvalue.UTF16String) (*ResponseIDWriter, error) {
	if writer == nil {
		return nil, errors.New("MCP response ID writer requires an HTTP response writer")
	}
	result := &ResponseIDWriter{writer: writer}
	if _, err := original.UTF8(); err == nil {
		return result, nil
	}
	// The pinned SDK's JSON decoder maps each unpaired surrogate to U+FFFD.
	// This lossy value is used only to recognize that SDK response, never as a
	// principal, tracker key, payload value, or the ID written back to a client.
	result.sdkID = utf16.Encode(utf16.Decode(original))
	encoded, err := canonicaljson.Canonical(original)
	if err != nil {
		return nil, err
	}
	result.encodedID = []byte(encoded)
	result.restore = true
	return result, nil
}

func (w *ResponseIDWriter) Header() http.Header { return w.writer.Header() }

// Unwrap preserves ResponseController deadlines, full-duplex and other
// transport operations through the app's error/logging wrappers.
func (w *ResponseIDWriter) Unwrap() http.ResponseWriter { return w.writer }

func (w *ResponseIDWriter) WriteHeader(status int) {
	if w.finished || w.committed {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		w.writer.WriteHeader(status)
		return
	}
	w.mode = responsePass
	if w.restore && (w.Header().Get("Content-Encoding") == "" || w.Header().Get("Content-Encoding") == "identity") {
		media, _, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
		if err == nil {
			switch media {
			case "application/json": w.mode = responseJSON
			case "text/event-stream": w.mode = responseSSE
			}
		}
	}
	if w.mode != responsePass {
		// An ID may grow from a replacement rune to a JSON surrogate escape.
		// The SDK does not set Content-Length; if a caller supplies one, let
		// net/http frame the rewritten bytes instead of forwarding a stale
		// length. Status and every other response header remain unchanged.
		w.Header().Del("Content-Length")
	}
	w.committed = true
	w.writer.WriteHeader(status)
}

func (w *ResponseIDWriter) Write(data []byte) (int, error) {
	if w.finished {
		return 0, io.ErrClosedPipe
	}
	if w.failure != nil {
		return 0, w.failure
	}
	if !w.committed {
		w.WriteHeader(http.StatusOK)
	}
	if w.mode == responsePass {
		return w.writeOutput(data)
	}
	w.pending = append(w.pending, data...)
	var err error
	if w.mode == responseJSON {
		err = w.drainJSON()
	} else {
		err = w.drainSSE(false)
	}
	// All input was accepted into the framing buffer. Output errors still
	// return immediately and are retained for Finish; no partial output is
	// retried after a writer reports failure or an unexplained short write.
	return len(data), err
}

// FlushError flushes completed messages and headers. A split, incomplete JSON
// token/event remains buffered until its boundary arrives, so flushing cannot
// leak half of an ID that later needs lossless restoration.
func (w *ResponseIDWriter) FlushError() error {
	if w.finished {
		if w.failure != nil { return w.failure }
		return io.ErrClosedPipe
	}
	if w.failure != nil { return w.failure }
	if !w.committed { w.WriteHeader(http.StatusOK) }
	if err := http.NewResponseController(w.writer).Flush(); err != nil {
		w.failure = fmt.Errorf("MCP response flush: %w", err)
	}
	return w.failure
}

// Finish is idempotent. It emits an unfinished tail byte-for-byte, never
// inventing a complete event or a protocol response, and reports any write or
// flush error even when the pinned SDK ignored it. After an output error it
// does not replay bytes of uncertain delivery.
func (w *ResponseIDWriter) Finish() error {
	if w.finished { return w.failure }
	w.finished = true
	if w.failure == nil && w.mode == responseSSE {
		_ = w.drainSSE(true)
	}
	if w.failure == nil && len(w.pending) != 0 {
		_, _ = w.writeOutput(w.pending)
	}
	w.pending = nil
	return w.failure
}

func (w *ResponseIDWriter) writeOutput(data []byte) (int, error) {
	n, err := w.writer.Write(data)
	if err == nil && n != len(data) { err = io.ErrShortWrite }
	if err != nil && w.failure == nil {
		w.failure = fmt.Errorf("MCP response write: %w", err)
	}
	return n, w.failure
}

// This scan only locates the end of the SDK's single JSON body. The shared
// lossless JSON parser below remains the grammar/semantic reader; this is not
// a second JSON validator or protocol schema.
func (w *ResponseIDWriter) drainJSON() error {
	for w.scan < len(w.pending) {
		char := w.pending[w.scan]
		w.scan++
		if !w.jsonStarted {
			if jsonSpace(char) { continue }
			if char != '{' && char != '[' {
				w.mode = responsePass
				data := w.pending
				w.pending = nil
				_, err := w.writeOutput(data)
				return err
			}
			w.jsonStarted, w.jsonDepth = true, 1
			continue
		}
		if w.jsonQuoted {
			if w.jsonEscape { w.jsonEscape = false; continue }
			if char == '\\' { w.jsonEscape = true } else if char == '"' { w.jsonQuoted = false }
			continue
		}
		switch char {
		case '"': w.jsonQuoted = true
		case '{', '[': w.jsonDepth++
		case '}', ']': w.jsonDepth--
		}
		if w.jsonDepth == 0 {
			data := w.restoreJSON(w.pending)
			w.pending = nil
			w.mode = responsePass
			_, err := w.writeOutput(data)
			return err
		}
	}
	return nil
}

func (w *ResponseIDWriter) drainSSE(final bool) error {
	for {
		end := w.eventEnd(final)
		if end == 0 { return nil }
		data := w.restoreEvent(w.pending[:end])
		w.pending = w.pending[end:]
		w.scan, w.lineStart = 0, 0
		if len(w.pending) == 0 { w.pending = nil }
		if _, err := w.writeOutput(data); err != nil { return err }
	}
}

func (w *ResponseIDWriter) eventEnd(final bool) int {
	for w.scan < len(w.pending) {
		char := w.pending[w.scan]
		if char != '\n' && char != '\r' { w.scan++; continue }
		if char == '\r' && w.scan+1 == len(w.pending) && !final { return 0 }
		empty := w.scan == w.lineStart
		w.scan++
		if char == '\r' && w.scan < len(w.pending) && w.pending[w.scan] == '\n' { w.scan++ }
		w.lineStart = w.scan
		if empty { return w.scan }
	}
	return 0
}

type responseDataLine struct { start, end, joined int }

func (w *ResponseIDWriter) restoreEvent(event []byte) []byte {
	var payload []byte
	var lines []responseDataLine
	eventName := ""
	for start := 0; start < len(event); {
		end := start
		for end < len(event) && event[end] != '\r' && event[end] != '\n' { end++ }
		next := end
		if next < len(event) { next++; if event[end] == '\r' && next < len(event) && event[next] == '\n' { next++ } }
		line := event[start:end]
		colon := bytes.IndexByte(line, ':')
		field, valueStart := line, end
		if colon >= 0 {
			field, valueStart = line[:colon], start+colon+1
			if valueStart < end && event[valueStart] == ' ' { valueStart++ }
		}
		if bytes.Equal(field, []byte("event")) { eventName = string(event[valueStart:end]) }
		if bytes.Equal(field, []byte("data")) {
			if len(lines) != 0 { payload = append(payload, '\n') }
			lines = append(lines, responseDataLine{start: valueStart, end: end, joined: len(payload)})
			payload = append(payload, event[valueStart:end]...)
		}
		start = next
	}
	if eventName != "" && eventName != "message" { return event }
	start, end, ok := w.responseIDSpan(payload)
	if !ok { return event }
	for _, line := range lines {
		if start >= line.joined && end <= line.joined+line.end-line.start {
			return replaceIDBytes(event, line.start+start-line.joined, line.start+end-line.joined, w.encodedID)
		}
	}
	// A valid JSON string cannot contain a literal SSE data-line newline.
	// Unrepresentable framing stays byte-for-byte, never a guessed rewrite.
	return event
}

func (w *ResponseIDWriter) restoreJSON(data []byte) []byte {
	start, end, ok := w.responseIDSpan(data)
	if !ok { return data }
	return replaceIDBytes(data, start, end, w.encodedID)
}

func replaceIDBytes(data []byte, start, end int, encoded []byte) []byte {
	result := make([]byte, 0, len(data)-(end-start)+len(encoded))
	result = append(result, data[:start]...)
	result = append(result, encoded...)
	return append(result, data[end:]...)
}

func (w *ResponseIDWriter) responseIDSpan(data []byte) (int, int, bool) {
	value, err := jsonvalue.Parse(data)
	if err != nil { return 0, 0, false }
	object, ok := value.(jsonvalue.Object)
	if !ok { return 0, 0, false }
	version, _ := objectField(object, "jsonrpc")
	if !textEquals(version, "2.0") { return 0, 0, false }
	if _, method := objectField(object, "method"); method { return 0, 0, false }
	_, result := objectField(object, "result")
	errorValue, failure := objectField(object, "error")
	if result == failure { return 0, 0, false }
	if failure { if _, objectError := errorValue.(jsonvalue.Object); !objectError { return 0, 0, false } }
	id, _ := objectField(object, "id")
	text, stringID := id.(jsonvalue.UTF16String)
	if !stringID || !text.Equal(w.sdkID) { return 0, 0, false }
	return topLevelIDSpan(data)
}

func jsonSpace(char byte) bool { return char == ' ' || char == '\t' || char == '\r' || char == '\n' }

// The input has already passed the shared parser. These lexical spans preserve
// every non-ID byte (including payload escapes, field order and whitespace).
func topLevelIDSpan(data []byte) (int, int, bool) {
	index := 0
	for jsonSpace(data[index]) { index++ }
	index++ // known root object
	startID, endID, count := 0, 0, 0
	for {
		for jsonSpace(data[index]) { index++ }
		if data[index] == '}' { return startID, endID, count == 1 }
		endKey := quotedEnd(data, index)
		key, err := jsonvalue.ParseString(data[index:endKey])
		if err != nil { return 0, 0, false }
		index = endKey
		for jsonSpace(data[index]) { index++ }
		index++ // colon
		for jsonSpace(data[index]) { index++ }
		start, end := index, jsonValueEnd(data, index)
		if textEquals(key, "id") { startID, endID, count = start, end, count+1 }
		index = end
		for jsonSpace(data[index]) { index++ }
		if data[index] == ',' { index++ }
	}
}

func quotedEnd(data []byte, start int) int {
	for index := start+1; index < len(data); index++ {
		if data[index] == '\\' { index++; continue }
		if data[index] == '"' { return index+1 }
	}
	return len(data)
}

func jsonValueEnd(data []byte, start int) int {
	if data[start] == '"' { return quotedEnd(data, start) }
	if data[start] != '{' && data[start] != '[' {
		index := start
		for index < len(data) && !jsonSpace(data[index]) && data[index] != ',' && data[index] != '}' && data[index] != ']' { index++ }
		return index
	}
	depth := 0
	for index := start; index < len(data); index++ {
		switch data[index] {
		case '"': index = quotedEnd(data, index)-1
		case '{', '[': depth++
		case '}', ']': depth--; if depth == 0 { return index+1 }
		}
	}
	return len(data)
}
