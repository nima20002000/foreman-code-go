package cihost_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/cihost"
	"github.com/nima20002000/foreman-code-go/backend/internal/cihost/cloudtest"
)

func TestCloudHTTPRetriesMissingCredentialsAfterBoundedInterval(t *testing.T) {
	server := cloudtest.NewGitHub(t)
	server.Handle(http.MethodGet, "/fixture", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	})
	now := time.Unix(1000, 0)
	loads := 0
	cache := cihost.NewCloudCredentialCache(func(context.Context, cihost.CloudProviderKind, string) (string, error) {
		loads++
		if loads == 1 {
			return "", errors.New("fixture-private-credential-path")
		}
		return cloudFixtureToken, nil
	}, func() time.Time { return now })
	client := fixtureCloudClient(t, cihost.CloudGitHub, server.URL(), cache)
	for range 2 {
		response, err := client.Request(context.Background(), "/fixture", cihost.CloudRequestOptions{})
		if err != nil || response != nil {
			t.Fatalf("missing credential did not select CLI fallback: response=%v err=%v", response, err)
		}
	}
	if loads != 1 || client.TransportSource() != "cli" || client.FallbackCount() != 2 || len(server.Requests()) != 0 || client.CredentialError() != "GitHub Actions REST credential resolution failed." {
		t.Fatal("missing credentials were retried early, exposed, or sent to the API")
	}
	now = now.Add(30 * time.Second)
	response, err := client.Request(context.Background(), "/fixture", cihost.CloudRequestOptions{})
	if err != nil || response == nil {
		t.Fatalf("bounded credential retry: %v", err)
	}
	defer response.Body.Close()
	if loads != 2 || client.TransportSource() != "rest" || client.CredentialError() != "" || client.FallbackCount() != 2 {
		t.Fatal("REST recovery lost its bounded retry or fallback history")
	}
}

func TestCloudHTTPRefreshesRejectedCredentialsAcrossConcurrentClients(t *testing.T) {
	server := cloudtest.NewCircleCI(t)
	var oldRequests atomic.Int32
	allOldRequests := make(chan struct{})
	server.Handle(http.MethodGet, "/api/v2/me", func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") == "Bearer fixture-expired" {
			if oldRequests.Add(1) == 2 {
				close(allOldRequests)
			}
			select {
			case <-allOldRequests:
			case <-request.Context().Done():
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if request.Header.Get("Authorization") != "Bearer fixture-refreshed" {
			t.Error("request used an unexpected fixture credential")
		}
		_, _ = io.WriteString(w, `{}`)
	})
	var loads atomic.Int32
	cache := cihost.NewCloudCredentialCache(func(context.Context, cihost.CloudProviderKind, string) (string, error) {
		if loads.Add(1) == 1 {
			return "fixture-expired", nil
		}
		return "fixture-refreshed", nil
	}, nil)
	clients := []*cihost.CloudHTTP{fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), cache), fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), cache)}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	results := make(chan error, len(clients))
	for _, client := range clients {
		go func() {
			response, err := client.Request(ctx, "/api/v2/me", cihost.CloudRequestOptions{})
			if response != nil {
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK {
					err = errors.New("refreshed credential was not accepted")
				}
			} else if err == nil {
				err = errors.New("refreshed credential unexpectedly selected CLI fallback")
			}
			results <- err
		}()
	}
	for range clients {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if loads.Load() != 2 || oldRequests.Load() != 2 || len(server.Requests()) != 4 {
		t.Fatalf("concurrent rejection did not share one refresh: loads=%d expired=%d requests=%d", loads.Load(), oldRequests.Load(), len(server.Requests()))
	}
}

func TestCloudHTTPCredentialsStayBoundToTheirAPIEndpoint(t *testing.T) {
	first, second := cloudtest.NewCircleCI(t), cloudtest.NewCircleCI(t)
	first.Handle(http.MethodGet, "/api/v2/me", func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer fixture-first" {
			t.Error("first provider received another endpoint's credential")
		}
		_, _ = io.WriteString(w, `{}`)
	})
	second.Handle(http.MethodGet, "/api/v2/me", func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer fixture-second" {
			t.Error("second provider received another endpoint's credential")
		}
		_, _ = io.WriteString(w, `{}`)
	})
	loads := 0
	cache := cihost.NewCloudCredentialCache(func(_ context.Context, _ cihost.CloudProviderKind, endpoint string) (string, error) {
		loads++
		if endpoint == first.URL() {
			return "fixture-first", nil
		}
		if endpoint == second.URL() {
			return "fixture-second", nil
		}
		return "", errors.New("fixture refused an unexpected API origin")
	}, nil)
	for _, endpoint := range []string{first.URL(), second.URL(), first.URL()} {
		client := fixtureCloudClient(t, cihost.CloudCircleCI, endpoint, cache)
		response, err := client.Request(context.Background(), "/api/v2/me", cihost.CloudRequestOptions{})
		if err != nil || response == nil {
			t.Fatalf("endpoint-scoped credential request: %v", err)
		}
		_ = response.Body.Close()
	}
	if loads != 2 {
		t.Fatalf("credential cache was not shared only within each endpoint: loads=%d", loads)
	}
}

type cloudRoundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip cloudRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestCloudHTTPHidesCredentialAndTransportErrorDetails(t *testing.T) {
	server := cloudtest.NewCircleCI(t)
	cache := cihost.NewCloudCredentialCache(func(context.Context, cihost.CloudProviderKind, string) (string, error) {
		return "", errors.New("fixture-private-credential-path")
	}, nil)
	client := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), cache)
	_, err := client.Available(context.Background())
	domain := requireCloudError(t, err, "CI_CLOUD_CREDENTIALS_UNAVAILABLE", 503)
	if domain.Message != "CircleCI credential configuration could not be read." {
		t.Fatal("credential loader exposed its private failure")
	}
	cache = cihost.NewCloudCredentialCache(func(context.Context, cihost.CloudProviderKind, string) (string, error) {
		return cloudFixtureToken, nil
	}, nil)
	client, err = cihost.NewCloudHTTP(cihost.CloudGitHub, cihost.CloudHTTPOptions{BaseURL: server.URL(), Credentials: cache,
		Transport: cloudRoundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("transport failed with fixture-cloud-token and signed URL")
		})})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Request(context.Background(), "/fixture", cihost.CloudRequestOptions{})
	domain = requireCloudError(t, err, "CI_CLOUD_FAILED", 502)
	if domain.Message != "GitHub Actions HTTPS request failed." {
		t.Fatal("transport exposed private error details")
	}
	_, err = client.DownloadURL(context.Background(), server.URL()+"/signed?signature=fixture-private", time.Second)
	domain = requireCloudError(t, err, "CI_CLOUD_FAILED", 502)
	if strings.Contains(domain.Message, "fixture-private") || domain.Message != "GitHub Actions artifacts could not be downloaded." {
		t.Fatal("artifact transport exposed a signed URL")
	}
}

// Observing this caller-owned context's Done request lets the test cancel the
// first HTTP caller only after the second is waiting on credential resolution.
type cloudWaitingContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (ctx *cloudWaitingContext) Done() <-chan struct{} {
	ctx.once.Do(func() { close(ctx.waiting) })
	return ctx.Context.Done()
}

func TestCloudHTTPCancelingOneCredentialWaiterPreservesAnother(t *testing.T) {
	server := cloudtest.NewCircleCI(t)
	server.Handle(http.MethodGet, "/api/v2/me", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	})
	lookupStarted, releaseLookup := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseLookup) }) }
	var loads atomic.Int32
	cache := cihost.NewCloudCredentialCache(func(ctx context.Context, _ cihost.CloudProviderKind, _ string) (string, error) {
		if loads.Add(1) == 1 {
			close(lookupStarted)
		}
		select {
		case <-releaseLookup:
			return cloudFixtureToken, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}, nil)
	defer release()
	first := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), cache)
	second := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), cache)
	deadline, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	firstContext, cancelFirst := context.WithCancel(deadline)
	defer cancelFirst()
	secondContext := &cloudWaitingContext{Context: deadline, waiting: make(chan struct{})}
	request := func(ctx context.Context, client *cihost.CloudHTTP, result chan<- error) {
		response, err := client.Request(ctx, "/api/v2/me", cihost.CloudRequestOptions{})
		if response != nil {
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				err = errors.New("live credential waiter received a failed HTTP response")
			}
		} else if err == nil {
			err = errors.New("live credential waiter lost its credential")
		}
		result <- err
	}
	firstResult, secondResult := make(chan error, 1), make(chan error, 1)
	go request(firstContext, first, firstResult)
	select {
	case <-lookupStarted:
	case <-deadline.Done():
		t.Fatal("first credential lookup did not start")
	}
	go request(secondContext, second, secondResult)
	select {
	case <-secondContext.waiting:
	case <-deadline.Done():
		t.Fatal("second credential waiter did not start")
	}
	cancelFirst()
	requireCloudError(t, <-firstResult, "CI_CLOUD_FAILED", 502)
	release()
	if err := <-secondResult; err != nil {
		t.Fatalf("canceling the first HTTP caller failed the still-live caller: %v", err)
	}
	if loads.Load() != 1 || len(server.Requests()) != 1 {
		t.Fatalf("independent waiter did not retain the shared credential lookup: loads=%d requests=%d", loads.Load(), len(server.Requests()))
	}
}
