package httpserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
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

func TestBufferedJSONRetainsPoisonPolicyWithLosslessKeys(t *testing.T) {
	for _, test := range []struct {
		name   string
		body   string
		status int
	}{
		{"distinct_surrogate_keys", `{"\ud800":1,"\udc00":2,"\ufffd":3}`, 204},
		{"surrogate_is_not_constructor", `{"constr\ud800uctor":{"prototype":{}}}`, 204},
		{"escaped_prototype", `{"\u005f_proto__":{}}`, 400},
		{"escaped_constructor", `{"\u0063onstructor":{"proto\u0074ype":null}}`, 400},
		{"duplicate_constructor_last_safe", `{"constructor":{"prototype":{}},"\u0063onstructor":null}`, 204},
		{"duplicate_constructor_last_forbidden", `{"constructor":null,"\u0063onstructor":{"prototype":{}}}`, 400},
		{"nested_array_poison", `[[{"safe":{"\u005f_proto__":null}}]]`, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := newBodyApp(t)
			called := false
			application.Handle("POST /json", func(w http.ResponseWriter, r *http.Request) error {
				called = true
				body, present := httpserver.JSONBody(r)
				if !present || string(body) != test.body {
					t.Errorf("validated JSON changed: %q, present=%v", body, present)
				}
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPost, "/json", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != test.status || called != (test.status == 204) {
				t.Fatalf("body result = %d %q, called=%v", response.Code, response.Body.String(), called)
			}
			if test.status == 400 && (!strings.Contains(response.Body.String(), `"code":"INVALID_REQUEST"`) ||
				response.Header().Get("Connection") != "close") {
				t.Fatalf("secure parser error boundary changed: %s", response.Body.String())
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
	reads   int
}

func (b *streamReadGate) Read(p []byte) (int, error) {
	b.reads++
	if !*b.entered {
		return 0, errors.New("streaming body was buffered before route authorization")
	}
	return b.reader.Read(p)
}

func (b *streamReadGate) Close() error {
	b.closed = true
	return nil
}

func TestReadBufferedBodyPreservesAuthorizedContextAndCachedJSON(t *testing.T) {
	type principalKey struct{}
	application := newBodyApp(t)
	authorized := false
	jsonText := `{"a":1,"a":2,"\ud800":true}`
	raw := append([]byte{0xef, 0xbb, 0xbf}, []byte(jsonText)...)
	body := &streamReadGate{reader: bytes.NewReader(raw), entered: &authorized}
	application.RegisterStream("POST /admit", func(w http.ResponseWriter, request *http.Request) error {
		if body.reads != 0 {
			t.Fatal("body was read before the route's authorization boundary")
		}
		authorized = true
		request = request.WithContext(context.WithValue(request.Context(), principalKey{}, "opaque-principal"))
		admitted, err := httpserver.ReadBufferedBody(w, request, 1_000_000)
		if err != nil {
			return err
		}
		if admitted.Context().Value(principalKey{}) != "opaque-principal" {
			t.Fatal("body admission lost the authenticated context")
		}
		reads := body.reads
		for index := 0; index < 3; index++ {
			normalized, present := httpserver.JSONBody(admitted)
			value, parsed := httpserver.ParsedJSONBody(admitted)
			object, isObject := value.(jsonvalue.Object)
			if !present || !parsed || string(normalized) != jsonText || !isObject || len(object) != 2 {
				t.Fatalf("cached JSON = %q, present=%v parsed=%v value=%#v", normalized, present, parsed, value)
			}
			if object[0].Value != json.Number("2") || len(object[1].Key) != 1 || object[1].Key[0] != 0xd800 || object[1].Value != true {
				t.Fatalf("cached duplicate/lossless-key semantics changed: %#v", object)
			}
			normalized[0] = '!'
		}
		replayed, err := io.ReadAll(admitted.Body)
		if err != nil {
			return err
		}
		if !bytes.Equal(replayed, raw) || body.reads != reads || !body.closed {
			t.Fatalf("raw replay/cache changed: raw=%q reads=%d want=%d closed=%v", replayed, body.reads, reads, body.closed)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	request := httptest.NewRequest(http.MethodPost, "/admit", nil)
	request.Header.Set("Content-Type", "application/json")
	request.Body, request.ContentLength = body, int64(len(raw))
	response := httptest.NewRecorder()
	application.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !authorized {
		t.Fatalf("authorized admission = %d %q, authorized=%v", response.Code, response.Body.String(), authorized)
	}
}

func TestReadBufferedBodyKeepsNullAndUnparsedBodiesDistinct(t *testing.T) {
	for _, test := range []struct {
		name    string
		media   string
		body    string
		present bool
	}{
		{"json_null", "application/json", "null", true},
		{"plain_text", "text/plain", "null", false},
		{"bodyless", "", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/admit", strings.NewReader(test.body))
			if test.media != "" {
				request.Header.Set("Content-Type", test.media)
			}
			response := httptest.NewRecorder()
			admitted, err := httpserver.ReadBufferedBody(response, request, 1_000_000)
			if err != nil {
				t.Fatal(err)
			}
			value, parsed := httpserver.ParsedJSONBody(admitted)
			_, rawPresent := httpserver.JSONBody(admitted)
			if parsed != test.present || rawPresent != test.present || value != nil {
				t.Fatalf("parsed=%v raw=%v value=%#v, want present=%v", parsed, rawPresent, value, test.present)
			}
		})
	}
}

func TestReadBufferedBodyRunsAfterAuthorizationWithRouteLimit(t *testing.T) {
	for _, test := range []struct {
		name       string
		authorized bool
		body       string
		declared   bool
		status     int
		reads      bool
	}{
		{"unauthorized", false, `{"__proto__":{}}`, true, 401, false},
		{"poison_after_auth", true, `{"__proto__":{}}`, true, 400, true},
		{"declared_route_limit", true, strings.Repeat("x", 1_000_001), true, 413, false},
		{"chunked_route_limit", true, strings.Repeat("x", 1_000_001), false, 413, true},
		{"exact_route_limit", true, `"` + strings.Repeat("x", 999_998) + `"`, true, 204, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			application := newBodyApp(t)
			authorized := false
			body := &streamReadGate{reader: strings.NewReader(test.body), entered: &authorized}
			application.RegisterStream("POST /admit", func(w http.ResponseWriter, request *http.Request) error {
				if !test.authorized {
					return domainerror.New("AUTH_REQUIRED", "Authentication is required.", 401, nil)
				}
				authorized = true
				if _, err := httpserver.ReadBufferedBody(w, request, 1_000_000); err != nil {
					return err
				}
				w.WriteHeader(http.StatusNoContent)
				return nil
			})
			request := httptest.NewRequest(http.MethodPost, "/admit", nil)
			request.Header.Set("Content-Type", "application/json")
			request.Body, request.ContentLength = body, -1
			if test.declared {
				request.ContentLength = int64(len(test.body))
			} else {
				request.TransferEncoding = []string{"chunked"}
			}
			response := httptest.NewRecorder()
			application.Handler().ServeHTTP(response, request)
			if response.Code != test.status || (body.reads > 0) != test.reads || authorized != test.authorized {
				t.Fatalf("admission = %d %q, reads=%d authorized=%v", response.Code, response.Body.String(), body.reads, authorized)
			}
		})
	}
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
