// Package cloudtest provides strict loopback-only cloud API fixtures. It does
// not manufacture provider admission, workflow results, or qualification data.
package cloudtest

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type Request struct {
	Method string
	Path   string
	Header http.Header
}

type Provider struct {
	server *httptest.Server
	mux    *http.ServeMux
	mu     sync.Mutex
	seen   []Request
}

func NewGitHub(t testing.TB) *Provider { return newProvider(t, "GitHub Actions") }

func NewCircleCI(t testing.TB) *Provider { return newProvider(t, "CircleCI") }

func newProvider(t testing.TB, label string) *Provider {
	t.Helper()
	provider := &Provider{mux: http.NewServeMux()}
	provider.mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		t.Errorf("unexpected %s fixture request: %s %s", label, request.Method, request.URL.Path)
		http.Error(w, "unexpected fake cloud API request", http.StatusNotFound)
	})
	provider.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		provider.mu.Lock()
		provider.seen = append(provider.seen, Request{Method: request.Method, Path: request.URL.RequestURI(), Header: request.Header.Clone()})
		provider.mu.Unlock()
		provider.mux.ServeHTTP(w, request)
	}))
	t.Cleanup(provider.server.Close)
	return provider
}

func (provider *Provider) URL() string { return provider.server.URL }

// Handle installs only an explicitly expected provider wire endpoint.
func (provider *Provider) Handle(method, path string, handler http.HandlerFunc) {
	provider.mux.HandleFunc(method+" "+path, handler)
}

func (provider *Provider) Requests() []Request {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	requests := make([]Request, len(provider.seen))
	for index, request := range provider.seen {
		requests[index] = Request{Method: request.Method, Path: request.Path, Header: request.Header.Clone()}
	}
	return requests
}
