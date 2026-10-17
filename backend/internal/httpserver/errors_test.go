package httpserver_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/app"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

type postgresError struct{ state string }

func (e postgresError) Error() string    { return "private SQL and stored payload" }
func (e postgresError) SQLState() string { return e.state }

func TestHTTPFailuresPreservePublicStatusAndRedactCauses(t *testing.T) {
	conflict := domainerror.New("REVISION_CONFLICT", "The revision changed.", 409, map[string]any{"revision": 7})
	conflict.Cause = errors.New("private cause")
	for _, test := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "domain", err: conflict, status: 409, code: "REVISION_CONFLICT"},
		{name: "wrapped domain", err: fmt.Errorf("private context: %w", conflict), status: 409, code: "REVISION_CONFLICT"},
		{name: "unknown", err: errors.New("private internal payload"), status: 500, code: "INTERNAL_ERROR"},
		{name: "connection admission", err: postgresError{"53300"}, status: 503, code: "DATABASE_BUSY"},
		{name: "wrapped admission", err: fmt.Errorf("request failed: %w", postgresError{"53300"}), status: 503, code: "DATABASE_BUSY"},
		{name: "read deadline", err: postgresError{"57014"}, status: 503, code: "DATABASE_READ_TIMEOUT"},
		{name: "lock deadline", err: postgresError{"55P03"}, status: 503, code: "DATABASE_READ_TIMEOUT"},
	} {
		t.Run(test.name, func(t *testing.T) {
			application, err := app.New(app.Options{})
			if err != nil {
				t.Fatal(err)
			}
			application.Handle("GET /failure", func(http.ResponseWriter, *http.Request) error { return test.err })
			recorder := httptest.NewRecorder()
			application.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/failure", nil))
			var envelope struct {
				Error map[string]any `json:"error"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != test.status || envelope.Error["code"] != test.code {
				t.Fatalf("failure = %d %s, want %d %s", recorder.Code, recorder.Body.String(), test.status, test.code)
			}
			if regexp.MustCompile(`private|stored payload`).Match(recorder.Body.Bytes()) {
				t.Fatalf("HTTP error leaked private context: %s", recorder.Body.String())
			}
			id, ok := envelope.Error["requestId"].(string)
			if !ok || !regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).MatchString(id) {
				t.Fatalf("requestId = %#v, want UUID", envelope.Error["requestId"])
			}
			if test.status == 503 && envelope.Error["class"] != nil {
				t.Fatalf("details.retryable must suppress class: %#v", envelope.Error)
			}
		})
	}
}

func TestHTTPNotFoundUsesTheSharedEnvelope(t *testing.T) {
	application, err := app.New(app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	application.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/not-real", nil))
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"requestId"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != 404 || envelope.Error.Code != "NOT_FOUND" || envelope.Error.RequestID == "" ||
		envelope.Error.Message != "The requested API route was not found." {
		t.Fatalf("not-found response = %d %s", recorder.Code, recorder.Body.String())
	}
}
