package httpserver_test

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

func newBodyApp(t *testing.T) *app.App {
	t.Helper()
	application, err := app.New(app.Options{Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return application
}

func TestBufferedBodyOverride(t *testing.T) {
	application := newBodyApp(t)
	application.HandleWithBodyLimit("POST /small", 4, func(w http.ResponseWriter, r *http.Request) error {
		_, err := io.Copy(w, r.Body)
		return err
	})
	for _, test := range []struct {
		body   string
		status int
	}{
		{"éé", 200},
		{"ééx", 413},
	} {
		request := httptest.NewRequest(http.MethodPost, "/small", strings.NewReader(test.body))
		request.Header.Set("Content-Type", "text/plain")
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("body %q = %d %q", test.body, response.Code, response.Body.String())
		}
	}
}

func TestBufferedJSONKeepsRawAndDecodedBytes(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  []byte
		json []byte
	}{
		{"bom", append([]byte{0xef, 0xbb, 0xbf}, []byte(`{"ok":true}`)...), []byte(`{"ok":true}`)},
		{"invalid_utf8", []byte{'"', 0xe2, 0x82, '"'}, []byte("\"�\"")},
		{"separate_invalid_bytes", []byte{'"', 0x80, 0x80, '"'}, []byte("\"��\"")},
		{"null_constructor", []byte(`{"constructor":null}`), []byte(`{"constructor":null}`)},
		{"duplicate_constructor", []byte(`{"constructor":{"prototype":{}},"constructor":null}`), []byte(`{"constructor":{"prototype":{}},"constructor":null}`)},
		{"large_number", []byte(`1e400`), []byte(`1e400`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := newBodyApp(t)
			called := false
			application.Handle("POST /json", func(w http.ResponseWriter, r *http.Request) error {
				called = true
				data, err := io.ReadAll(r.Body)
				if err != nil {
					return err
				}
				decoded, ok := httpserver.JSONBody(r)
				if !ok || !bytes.Equal(data, test.raw) || !bytes.Equal(decoded, test.json) {
					t.Errorf("raw=%q decoded=%q present=%v", data, decoded, ok)
				}
				if len(decoded) > 0 {
					decoded[0] = '!'
					again, _ := httpserver.JSONBody(r)
					if !bytes.Equal(again, test.json) {
						t.Error("caller changed the retained transport JSON")
					}
				}
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPost, "/json", bytes.NewReader(test.raw))
			request.Header.Set("Content-Type", "application/json")
			request.ContentLength = -1
			request.TransferEncoding = []string{"chunked"}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusNoContent || !called {
				t.Fatalf("JSON body = %d %q, called=%v", response.Code, response.Body.String(), called)
			}
		})
	}
}

func TestBufferedBodyCountsDecodedUTF8Bytes(t *testing.T) {
	for _, test := range []struct {
		name     string
		limit    int64
		declared int64
		status   int
	}{
		{"decoded_limit", 4, -1, 413},
		{"decoded_length", 8, 4, 400},
		{"decoded_boundary", 5, -1, 204},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := newBodyApp(t)
			application.HandleWithBodyLimit("POST /json", test.limit, func(w http.ResponseWriter, r *http.Request) error {
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPost, "/json", bytes.NewReader([]byte{'"', 0xe2, 0x82, '"'}))
			request.Header.Set("Content-Type", "application/json")
			request.ContentLength = test.declared
			if test.declared < 0 {
				request.TransferEncoding = []string{"chunked"}
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("decoded byte boundary = %d %q", response.Code, response.Body.String())
			}
		})
	}
}

type streamReadGate struct {
	reader  io.Reader
	entered *bool
	closed  bool
}

func (b *streamReadGate) Read(p []byte) (int, error) {
	if !*b.entered {
		return 0, errors.New("streaming body was buffered before route authorization")
	}
	return b.reader.Read(p)
}

func (b *streamReadGate) Close() error {
	b.closed = true
	return nil
}

func TestStreamingBodyReadsOnlyInsideHandler(t *testing.T) {
	application := newBodyApp(t)
	entered := false
	body := &streamReadGate{reader: strings.NewReader("raw\x00data"), entered: &entered}
	application.HandleStreamingBody("PUT /upload", 32, func(w http.ResponseWriter, r *http.Request) error {
		entered = true
		data, err := io.ReadAll(r.Body)
		if err != nil {
			return err
		}
		if _, present := httpserver.JSONBody(r); present {
			t.Error("raw upload acquired buffered JSON state")
		}
		if err := r.Body.Close(); err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	})
	request := httptest.NewRequest(http.MethodPut, "/upload", nil)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Body, request.ContentLength = body, -1
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 200 || response.Body.String() != "raw\x00data" || !body.closed {
		t.Fatalf("streamed body = %d %q, closed=%v", response.Code, response.Body.String(), body.closed)
	}
}

func TestStreamingBodyEnforcesDeclaredAndChunkedLimits(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		name := "declared"
		if chunked {
			name = "chunked"
		}
		t.Run(name, func(t *testing.T) {
			application := newBodyApp(t)
			entered, succeeded := false, false
			application.HandleStreamingBody("PUT /upload", 4, func(w http.ResponseWriter, r *http.Request) error {
				entered = true
				if _, err := io.Copy(io.Discard, r.Body); err != nil {
					return err
				}
				succeeded = true
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPut, "/upload", strings.NewReader("12345"))
			request.Header.Set("Content-Type", "application/octet-stream")
			if chunked {
				request.ContentLength = -1
				request.TransferEncoding = []string{"chunked"}
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != 413 || succeeded || entered != chunked || !strings.Contains(response.Body.String(), `"code":"REQUEST_TOO_LARGE"`) {
				t.Fatalf("stream limit = %d %q, entered=%v succeeded=%v", response.Code, response.Body.String(), entered, succeeded)
			}
		})
	}
}

type failingCloseBody struct {
	io.Reader
	closed bool
}

func (b *failingCloseBody) Close() error {
	b.closed = true
	return errors.New("transport close failed")
}

func TestBufferedBodyRetainsCloseFailure(t *testing.T) {
	application := newBodyApp(t)
	called := false
	application.Handle("POST /json", func(w http.ResponseWriter, r *http.Request) error {
		called = true
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	body := &failingCloseBody{Reader: strings.NewReader("{}")}
	request := httptest.NewRequest(http.MethodPost, "/json", nil)
	request.Header.Set("Content-Type", "application/json")
	request.Body, request.ContentLength = body, 2
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 500 || called || !body.closed || strings.Contains(response.Body.String(), "transport close failed") {
		t.Fatalf("close failure = %d %q, called=%v closed=%v", response.Code, response.Body.String(), called, body.closed)
	}
}

func TestBufferedBodyAllowsAbsentBodyAndPlainText(t *testing.T) {
	for _, test := range []struct {
		name  string
		media string
		body  string
	}{
		{"absent", "", ""},
		{"empty_plain_text", "text/plain", ""},
		{"plain_text", "text/plain; ignored-parameter", "not JSON"},
		{"javascript_whitespace", "\ufefftext/plain\u00a0", "not JSON"},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := newBodyApp(t)
			application.Handle("POST /body", func(w http.ResponseWriter, r *http.Request) error {
				if _, present := httpserver.JSONBody(r); present {
					t.Error("non-JSON request acquired buffered JSON state")
				}
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPost, "/body", strings.NewReader(test.body))
			if test.media != "" {
				request.Header.Set("Content-Type", test.media)
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("non-JSON body = %d %q", response.Code, response.Body.String())
			}
		})
	}
}

func TestBufferedBodyRejectsNonJavaScriptWhitespace(t *testing.T) {
	application := newBodyApp(t)
	application.Handle("POST /body", func(w http.ResponseWriter, r *http.Request) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	request := httptest.NewRequest(http.MethodPost, "/body", strings.NewReader("not JSON"))
	request.Header.Set("Content-Type", "\u0085text/plain")
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 415 {
		t.Fatalf("NEXT LINE media type = %d %q", response.Code, response.Body.String())
	}
}

func TestBufferedBodyRejectsExpandingUnicodeTypeCase(t *testing.T) {
	application := newBodyApp(t)
	application.Handle("POST /body", func(w http.ResponseWriter, r *http.Request) error {
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	request := httptest.NewRequest(http.MethodPost, "/body", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "appl\u0130cation/json")
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 415 || !strings.Contains(response.Body.String(), `"code":"UNSUPPORTED_MEDIA_TYPE"`) {
		t.Fatalf("expanding Unicode media case = %d %q", response.Code, response.Body.String())
	}
}

func TestBufferedBodyKeepsValidUnicodeMediaCaseOnMissingRoute(t *testing.T) {
	application := newBodyApp(t)
	request := httptest.NewRequest(http.MethodPost, "/missing", strings.NewReader("raw"))
	request.Header.Set("Content-Type", "application/x-\u212a")
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != 404 || !strings.Contains(response.Body.String(), `"code":"NOT_FOUND"`) {
		t.Fatalf("valid Unicode media case = %d %q", response.Code, response.Body.String())
	}
}
