package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// DefaultBodyLimit is Fastify's default limit for buffered request bodies.
const DefaultBodyLimit int64 = 1 << 20

type jsonBodyKey struct{}

// JSONBody returns a copy of transport-validated JSON for a generated decoder.
// It applies the reference UTF-8 and leading-BOM handling without changing the
// original bytes replayed through Request.Body. Domain validation remains generated.
// The boolean is false for bodyless, plain-text, MCP, and streaming requests.
func JSONBody(r *http.Request) (json.RawMessage, bool) {
	body, ok := r.Context().Value(jsonBodyKey{}).([]byte)
	return bytes.Clone(body), ok
}

// BufferBody applies the reference's default JSON/plain-text parser boundary.
// Register streaming uploads, SSE, WebSockets, and MCP through their own boundary.
func BufferBody(limit int64, next Handler) Handler {
	return bufferBody(limit, false, next)
}

// BufferNotFoundBody preserves Fastify's 404 exception for unsupported media.
// Recognized content types still pass through the ordinary parser and byte limit.
func BufferNotFoundBody(limit int64, next Handler) Handler {
	return bufferBody(limit, true, next)
}

func bufferBody(limit int64, notFound bool, next Handler) Handler {
	if limit <= 0 || next == nil {
		panic("buffered request body requires a positive limit and handler")
	}
	return func(w http.ResponseWriter, r *http.Request) error {
		media, parse, err := bodyParser(r, notFound)
		if err != nil || !parse {
			if err != nil {
				return err
			}
			return next(w, r)
		}
		if r.ContentLength > limit {
			return bodyFailure(w, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.", 413)
		}
		original := r.Body
		if original == nil {
			original = http.NoBody
		}
		data, readErr := io.ReadAll(http.MaxBytesReader(w, original, limit))
		closeErr := original.Close()
		if readErr != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(readErr, &tooLarge) {
				readErr = bodyFailure(w, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.", 413)
			} else if errors.Is(readErr, io.ErrUnexpectedEOF) {
				readErr = bodyLengthFailure(w)
			}
			return errors.Join(readErr, closeErr)
		}
		if closeErr != nil {
			return closeErr
		}
		text := bodyText(data)
		if int64(len(text)) > limit {
			return bodyFailure(w, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.", 413)
		}
		if r.ContentLength >= 0 && int64(len(text)) != r.ContentLength {
			return bodyLengthFailure(w)
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		if media == "application/json" {
			text = bytes.TrimPrefix(text, []byte{0xef, 0xbb, 0xbf})
			if !validRequestJSON(text) {
				return bodyFailure(w, "INVALID_REQUEST", "The request body must contain valid JSON.", 400)
			}
			r = r.WithContext(context.WithValue(r.Context(), jsonBodyKey{}, text))
		}
		return next(w, r)
	}
}

// StreamingBody caps raw bytes as the handler reads them, without buffering or
// selecting a content parser. The route owns content rules and authorization.
// A reader failure must reach the shared error boundary before committing success.
func StreamingBody(limit int64, next Handler) Handler {
	if limit <= 0 || next == nil {
		panic("streaming request body requires a positive limit and handler")
	}
	return func(w http.ResponseWriter, r *http.Request) error {
		if r.ContentLength > limit {
			return bodyFailure(w, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.", 413)
		}
		body := r.Body
		if body == nil {
			body = http.NoBody
		}
		r.Body = &limitedBody{ReadCloser: http.MaxBytesReader(w, body, limit), writer: w}
		return next(w, r)
	}
}

type limitedBody struct {
	io.ReadCloser
	writer http.ResponseWriter
}

func (b *limitedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		err = bodyFailure(b.writer, "REQUEST_TOO_LARGE", "The request body exceeds the allowed size.", 413)
	}
	return n, err
}

func bodyFailure(w http.ResponseWriter, code, message string, status int) error {
	w.Header().Set("Connection", "close")
	return domainerror.New(code, message, status, nil)
}

func bodyLengthFailure(w http.ResponseWriter) error {
	return bodyFailure(w, "INVALID_REQUEST", "The request body does not match its Content-Length.", 400)
}

func bodyParser(r *http.Request, notFound bool) (string, bool, error) {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, "QUERY":
	default:
		return "", false, nil
	}
	_, hasType := r.Header["Content-Type"]
	empty := r.ContentLength == 0 && len(r.TransferEncoding) == 0 && r.Header.Get("Transfer-Encoding") == ""
	if r.Method == "QUERY" && (!hasType || empty) {
		// The frozen API does not normalize Fastify's QUERY-specific route errors.
		return "", false, fmt.Errorf("QUERY requires a content type and a non-empty body")
	}
	if !hasType && empty {
		return "", false, nil
	}
	media := bodyMediaType(r.Header.Get("Content-Type"))
	if media == "application/json" || media == "text/plain" {
		return media, true, nil
	}
	if notFound && (media != "" || !hasType) {
		return "", false, nil
	}
	return "", false, domainerror.New("UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported.", 415, nil)
}

func bodyMediaType(header string) string {
	media, _, _ := strings.Cut(header, ";")
	typeName, subtype, found := strings.Cut(strings.ToLower(media), "/")
	if !found {
		return ""
	}
	typeName = strings.TrimLeftFunc(typeName, mediaSpace)
	subtype = strings.TrimRightFunc(subtype, mediaSpace)
	for _, token := range []string{typeName, subtype} {
		if token == "" {
			return ""
		}
		for _, char := range token {
			if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", char) {
				continue
			}
			return ""
		}
	}
	return typeName + "/" + subtype
}

func mediaSpace(char rune) bool {
	// JavaScript trim/\s includes BOM and excludes NEXT LINE (U+0085).
	return char == '\ufeff' || char != '\u0085' && unicode.IsSpace(char)
}

// bodyText matches Node's UTF-8 replacement of each maximal invalid subsequence.
// Fastify counts the resulting UTF-8 bytes, including a leading BOM, before JSON parsing.
func bodyText(data []byte) []byte {
	if utf8.Valid(data) {
		return data
	}
	text := make([]byte, 0, len(data))
	for len(data) > 0 {
		_, size := utf8.DecodeRune(data)
		if size > 1 || data[0] < utf8.RuneSelf {
			text = append(text, data[:size]...)
			data = data[size:]
			continue
		}
		want := 1
		if data[0] >= 0xc2 && data[0] <= 0xdf {
			want = 2
		} else if data[0] >= 0xe0 && data[0] <= 0xef {
			want = 3
		} else if data[0] >= 0xf0 && data[0] <= 0xf4 {
			want = 4
		}
		used := 1
		for used < want && used < len(data) {
			low, high := byte(0x80), byte(0xbf)
			if used == 1 {
				switch data[0] {
				case 0xe0:
					low = 0xa0
				case 0xed:
					high = 0x9f
				case 0xf0:
					low = 0x90
				case 0xf4:
					high = 0x8f
				}
			}
			if data[used] < low || data[used] > high {
				break
			}
			used++
		}
		text = append(text, 0xef, 0xbf, 0xbd)
		data = data[used:]
	}
	return text
}

func validRequestJSON(data []byte) bool {
	if !json.Valid(data) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return false
	}
	queue := []any{value}
	for len(queue) > 0 {
		value, queue = queue[len(queue)-1], queue[:len(queue)-1]
		switch node := value.(type) {
		case map[string]any:
			if _, forbidden := node["__proto__"]; forbidden {
				return false
			}
			if constructor, ok := node["constructor"].(map[string]any); ok {
				if _, forbidden := constructor["prototype"]; forbidden {
					return false
				}
			}
			for _, child := range node {
				queue = append(queue, child)
			}
		case []any:
			queue = append(queue, node...)
		}
	}
	return true
}
