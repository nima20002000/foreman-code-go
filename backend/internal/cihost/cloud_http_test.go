package cihost_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/cihost"
	"github.com/nima20002000/foreman-code-go/backend/internal/cihost/cloudtest"
	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/httpserver"
)

const cloudFixtureToken = "fixture-cloud-token"

func fixtureCloudClient(t *testing.T, provider cihost.CloudProviderKind, endpoint string, cache *cihost.CloudCredentialCache) *cihost.CloudHTTP {
	t.Helper()
	if cache == nil {
		cache = cihost.NewCloudCredentialCache(func(context.Context, cihost.CloudProviderKind, string) (string, error) {
			return cloudFixtureToken, nil
		}, nil)
	}
	client, err := cihost.NewCloudHTTP(provider, cihost.CloudHTTPOptions{BaseURL: endpoint, Credentials: cache})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func requireCloudError(t *testing.T, err error, code string, status int) *domainerror.Error {
	t.Helper()
	domain, ok := domainerror.As(err)
	if !ok || domain.Code != code || domain.Status != status {
		t.Fatalf("unexpected cloud failure: %v", err)
	}
	return domain
}

func TestCloudHTTPRoutesProviderRequestsToIsolatedEndpoints(t *testing.T) {
	for _, provider := range []cihost.CloudProviderKind{cihost.CloudGitHub, cihost.CloudCircleCI} {
		t.Run(string(provider), func(t *testing.T) {
			server, path, key := cloudtest.NewGitHub(t), "/repos/fixture/mirror/actions/runs/42", "FOREMAN_CI_GITHUB_API_BASE_URL"
			if provider == cihost.CloudCircleCI {
				server, path, key = cloudtest.NewCircleCI(t), "/api/v2/pipeline/fixture", "FOREMAN_CI_CIRCLECI_BASE_URL"
			}
			server.Handle(http.MethodGet, path, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"state":"running"}`)
			})
			cache := cihost.NewCloudCredentialCache(func(_ context.Context, got cihost.CloudProviderKind, endpoint string) (string, error) {
				if got != provider || endpoint != server.URL() {
					return "", errors.New("credential origin mismatch")
				}
				return cloudFixtureToken, nil
			}, nil)
			client, err := cihost.NewCloudHTTP(provider, cihost.CloudHTTPOptions{Credentials: cache,
				LookupEnv: func(name string) (string, bool) { return server.URL() + "/", name == key }})
			if err != nil {
				t.Fatal(err)
			}
			response, err := client.Request(context.Background(), path, cihost.CloudRequestOptions{Headers: http.Header{"If-None-Match": {"fixture-etag"}}})
			if err != nil || response == nil {
				t.Fatalf("fixture API request: %v", err)
			}
			var body struct {
				State string `json:"state"`
			}
			if err := client.JSON(response, &body); err != nil || body.State != "running" {
				t.Fatalf("fixture API response: state=%q err=%v", body.State, err)
			}
			requests := server.Requests()
			if len(requests) != 1 || requests[0].Header.Get("Authorization") != "Bearer "+cloudFixtureToken || requests[0].Header.Get("If-None-Match") != "fixture-etag" || requests[0].Header.Get("User-Agent") != "foreman-code" {
				t.Fatal("provider request lost authentication, cache validation, or client identity")
			}
			if provider == cihost.CloudGitHub && (requests[0].Header.Get("Accept") != "application/vnd.github+json" || requests[0].Header.Get("X-GitHub-Api-Version") != "2022-11-28") {
				t.Fatal("GitHub API request lost its negotiated wire version")
			}
			if client.TransportSource() != "rest" || client.FallbackCount() != 0 || client.CredentialError() != "" {
				t.Fatal("successful REST request reported a CLI fallback")
			}
		})
	}
}

func TestCloudHTTPEndpointDefaultsAndInvalidOverrides(t *testing.T) {
	for provider, want := range map[cihost.CloudProviderKind]string{cihost.CloudGitHub: "https://api.github.com", cihost.CloudCircleCI: "https://circleci.com"} {
		endpoint, err := cihost.ResolveCloudAPIBaseURL(provider, "", func(string) (string, bool) { return "", false })
		if err != nil || endpoint != want {
			t.Fatalf("production default changed: endpoint=%q err=%v", endpoint, err)
		}
	}
	for _, endpoint := range []string{"file:///fixture", "http://fixture-token@127.0.0.1", "https://fixture.invalid?secret=fixture-token", "/relative", "https://fixture.invalid#secret"} {
		_, err := cihost.NewCloudHTTP(cihost.CloudCircleCI, cihost.CloudHTTPOptions{BaseURL: endpoint})
		domain := requireCloudError(t, err, "CI_CLOUD_FAILED", 502)
		if strings.Contains(domain.Message, "fixture-token") || strings.Contains(domain.Message, endpoint) {
			t.Fatal("invalid endpoint failure exposed private configuration")
		}
	}
}

func TestCloudHTTPDoesNotFollowAuthenticatedAPIRedirects(t *testing.T) {
	var redirected atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirected.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(other.Close)
	server := cloudtest.NewGitHub(t)
	server.Handle(http.MethodGet, "/redirect", func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, other.URL+"/should-not-run", http.StatusFound)
	})
	client := fixtureCloudClient(t, cihost.CloudGitHub, server.URL(), nil)
	response, err := client.Request(context.Background(), "/redirect", cihost.CloudRequestOptions{})
	if err != nil || response == nil {
		t.Fatalf("API redirect request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusFound || redirected.Load() != 0 {
		t.Fatal("API client followed an authentication-bearing redirect")
	}
}

func TestCloudHTTPDownloadsSignedArtifactsWithoutAPICredentials(t *testing.T) {
	var downloads atomic.Int32
	artifact := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		downloads.Add(1)
		if request.Header.Get("Authorization") != "" || request.Header.Get("X-GitHub-Api-Version") != "" || request.Header.Get("Cookie") != "" {
			t.Error("artifact URL received API credentials or API-only headers")
		}
		_, _ = io.WriteString(w, "fixture-artifact-bytes")
	}))
	t.Cleanup(artifact.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" {
			t.Error("signed redirect received API credentials")
		}
		http.Redirect(w, request, artifact.URL+"/artifact", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)
	server := cloudtest.NewGitHub(t)
	server.Handle(http.MethodGet, "/repos/fixture/mirror/actions/artifacts/42/zip", func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, redirect.URL+"/signed?signature=fixture-private", http.StatusFound)
	})
	client := fixtureCloudClient(t, cihost.CloudGitHub, server.URL(), nil)
	response, err := client.Request(context.Background(), "/repos/fixture/mirror/actions/artifacts/42/zip", cihost.CloudRequestOptions{})
	if err != nil || response == nil {
		t.Fatalf("artifact API request: %v", err)
	}
	bytes, err := client.Download(context.Background(), response, time.Second)
	if err != nil || string(bytes) != "fixture-artifact-bytes" || downloads.Load() != 1 {
		t.Fatalf("artifact download: bytes=%q count=%d err=%v", bytes, downloads.Load(), err)
	}
}

func TestCloudHTTPCancellationStopsInFlightRequest(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	server := cloudtest.NewCircleCI(t)
	server.Handle(http.MethodGet, "/api/v2/pipeline/blocked", func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
		close(canceled)
	})
	client := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		response, err := client.Request(ctx, "/api/v2/pipeline/blocked", cihost.CloudRequestOptions{})
		if response != nil {
			_ = response.Body.Close()
		}
		result <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("fixture request did not start")
	}
	cancel()
	requireCloudError(t, <-result, "CI_CLOUD_FAILED", 502)
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("canceled HTTP request remained active on the provider")
	}
}

func TestCloudHTTPPreservesRateLimitAndRedactedFailureResponses(t *testing.T) {
	for _, fixture := range []struct {
		name, body, remaining, code string
		status, expectedStatus       int
	}{
		{"quota", `{"message":"quota"}`, "0", "CI_CLOUD_RATE_LIMITED", 403, 503},
		{"rate-status", `{}`, "", "CI_CLOUD_RATE_LIMITED", 429, 503},
		{"rate-message", `{"message":"too many requests"}`, "", "CI_CLOUD_RATE_LIMITED", 400, 503},
		{"failed", `{"message":"denied fixture-cloud-token"}`, "", "CI_CLOUD_FAILED", 403, 502},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			server := cloudtest.NewGitHub(t)
			server.Handle(http.MethodGet, "/failure", func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("X-RateLimit-Remaining", fixture.remaining)
				w.WriteHeader(fixture.status)
				_, _ = io.WriteString(w, fixture.body)
			})
			client := fixtureCloudClient(t, cihost.CloudGitHub, server.URL(), nil)
			response, err := client.Request(context.Background(), "/failure", cihost.CloudRequestOptions{})
			if err != nil || response == nil {
				t.Fatalf("failure response request: %v", err)
			}
			err = client.Check(context.Background(), response, func(detail string) string { return "provider rejected: " + detail })
			domain := requireCloudError(t, err, fixture.code, fixture.expectedStatus)
			if strings.Contains(domain.Message, cloudFixtureToken) {
				t.Fatal("public provider failure exposed its token")
			}
			if fixture.name == "failed" && domain.Message != "provider rejected: gh: denied [redacted] (HTTP 403)" {
				t.Fatalf("provider failure contract changed: %s", domain.Message)
			}
		})
	}
}

func TestCloudHTTPRejectsMalformedJSONResponses(t *testing.T) {
	server := cloudtest.NewCircleCI(t)
	server.Handle(http.MethodGet, "/api/v2/pipeline/invalid", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{} {"fixture-private":"value"}`)
	})
	client := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), nil)
	response, err := client.Request(context.Background(), "/api/v2/pipeline/invalid", cihost.CloudRequestOptions{})
	if err != nil || response == nil {
		t.Fatalf("invalid JSON response request: %v", err)
	}
	var result any
	domain := requireCloudError(t, client.JSON(response, &result), "CI_CLOUD_FAILED", 502)
	if domain.Message != "CircleCI returned an invalid response." {
		t.Fatalf("invalid response exposed payload: %s", domain.Message)
	}
}

func TestCloudHTTPBoundsFailureDetailByUTF16Units(t *testing.T) {
	for _, fixture := range []struct {
		name, detail, want string
	}{
		{"multibyte", strings.Repeat("界", 400), strings.Repeat("界", 300)},
		{"surrogate-pairs", strings.Repeat("\U0001F600", 151), strings.Repeat("\U0001F600", 150)},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			server := cloudtest.NewCircleCI(t)
			server.Handle(http.MethodGet, "/api/v2/failure", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": fixture.detail})
			})
			client := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), nil)
			response, err := client.Request(context.Background(), "/api/v2/failure", cihost.CloudRequestOptions{})
			if err != nil || response == nil {
				t.Fatalf("Unicode failure response request: %v", err)
			}
			err = client.Check(context.Background(), response, func(detail string) string { return detail })
			domain := requireCloudError(t, err, "CI_CLOUD_FAILED", 502)
			if domain.Message != fixture.want {
				t.Fatal("public cloud failure was truncated by bytes instead of UTF-16 units")
			}
		})
	}
}

func TestCloudHTTPPreservesCutSurrogateInPublicErrorJSON(t *testing.T) {
	server := cloudtest.NewCircleCI(t)
	server.Handle(http.MethodGet, "/api/v2/failure", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "A" + strings.Repeat("\U0001F600", 150)})
	})
	client := fixtureCloudClient(t, cihost.CloudCircleCI, server.URL(), nil)
	response, err := client.Request(context.Background(), "/api/v2/failure", cihost.CloudRequestOptions{})
	if err != nil || response == nil {
		t.Fatalf("cut-surrogate failure response request: %v", err)
	}
	err = client.Check(context.Background(), response, func(detail string) string { return detail })
	requireCloudError(t, err, "CI_CLOUD_FAILED", 502)
	public := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/cloud-fixture", nil)
	(httpserver.ErrorHandler{}).Write(public, request, err)
	if public.Code != http.StatusBadGateway {
		t.Fatalf("cloud error changed its HTTP status: %d", public.Code)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(public.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	var failure map[string]json.RawMessage
	if err := json.Unmarshal(envelope["error"], &failure); err != nil {
		t.Fatal(err)
	}
	wholePairs, err := json.Marshal("A" + strings.Repeat("\U0001F600", 149))
	if err != nil {
		t.Fatal(err)
	}
	// Frozen TS retains the 300th UTF-16 unit even when it is a high surrogate;
	// JSON.stringify escapes it. U+FFFD is not an equivalent public string.
	want := string(wholePairs[:len(wholePairs)-1]) + `\ud83d"`
	if string(failure["message"]) != want {
		t.Fatal("public error JSON lost the cut high surrogate; shared lossless UTF-16 message support is required")
	}
}
