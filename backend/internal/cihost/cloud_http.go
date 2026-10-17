package cihost

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

type CloudHTTPOptions struct {
	BaseURL     string
	LookupEnv   func(string) (string, bool)
	Credentials *CloudCredentialCache
	Transport   http.RoundTripper
}

type CloudRequestOptions struct {
	Timeout time.Duration
	Headers http.Header
}

// CloudHTTP ports cloudHttp.ts's provider HTTP boundary. Provider dispatch,
// persisted runs, and shared CI response DTOs are supplied by later slices.
type CloudHTTP struct {
	key         cloudCredentialKey
	credentials *CloudCredentialCache
	api         *http.Client
	download    *http.Client
	mu          sync.Mutex
	source      string
	lastError   string
	fallbacks   uint64
}

func NewCloudHTTP(provider CloudProviderKind, options CloudHTTPOptions) (*CloudHTTP, error) {
	endpoint, err := ResolveCloudAPIBaseURL(provider, options.BaseURL, options.LookupEnv)
	if err != nil {
		return nil, err
	}
	credentials := options.Credentials
	if credentials == nil {
		credentials = NewCloudCredentialCache(nil, nil)
	}
	return &CloudHTTP{
		key:         cloudCredentialKey{provider: provider, endpoint: endpoint},
		credentials: credentials,
		api: &http.Client{Transport: options.Transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		download: &http.Client{Transport: options.Transport},
	}, nil
}

func (client *CloudHTTP) Endpoint() string { return client.key.endpoint }

// These primitive observations avoid inventing the pending generated transport DTO.
func (client *CloudHTTP) TransportSource() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.source
}

func (client *CloudHTTP) CredentialError() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.lastError
}

func (client *CloudHTTP) FallbackCount() uint64 {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.fallbacks
}

func (client *CloudHTTP) observe(token string) {
	client.mu.Lock()
	defer client.mu.Unlock()
	if token != "" {
		client.source, client.lastError = "rest", ""
		return
	}
	client.source = "cli"
	client.lastError = cloudProviderLabel(client.key.provider) + " REST credential resolution failed."
	client.fallbacks++
}

func (client *CloudHTTP) Available(ctx context.Context) (bool, error) {
	entry, err := client.credentials.resolve(ctx, client.key)
	if err != nil {
		return false, client.requestError(err)
	}
	client.observe(entry.token)
	return entry.token != "", nil
}

// Request returns nil when the caller must use its existing CLI transport.
// ctx carries a multi-request operation deadline; Timeout bounds this request.
func (client *CloudHTTP) Request(ctx context.Context, path string, options CloudRequestOptions) (*http.Response, error) {
	entry, err := client.credentials.resolve(ctx, client.key)
	if err != nil {
		return nil, client.requestError(err)
	}
	client.observe(entry.token)
	if entry.token == "" {
		return nil, nil
	}
	if !strings.HasPrefix(path, "/") {
		return nil, client.requestError(nil)
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	response, err := client.send(requestContext, path, entry.token, options.Headers)
	if err == nil && response.StatusCode == http.StatusUnauthorized {
		_ = response.Body.Close()
		client.credentials.reject(client.key, entry)
		entry, err = client.credentials.resolve(requestContext, client.key)
		if err == nil {
			client.observe(entry.token)
			if entry.token == "" {
				cancel()
				return nil, nil
			}
			response, err = client.send(requestContext, path, entry.token, options.Headers)
		}
	}
	if err != nil {
		cancel()
		return nil, client.requestError(err)
	}
	response.Body = &cloudResponseBody{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

func (client *CloudHTTP) send(ctx context.Context, path, token string, headers http.Header) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.key.endpoint+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("User-Agent", "foreman-code")
	if client.key.provider == CloudGitHub {
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	for name, values := range headers {
		request.Header[name] = append([]string(nil), values...)
	}
	return client.api.Do(request)
}

func (client *CloudHTTP) JSON(response *http.Response, target any) error {
	defer response.Body.Close()
	bytes, err := io.ReadAll(response.Body)
	if err != nil || json.Unmarshal(bytes, target) != nil {
		return domainerror.New("CI_CLOUD_FAILED", cloudProviderLabel(client.key.provider)+" returned an invalid response.", 502, nil)
	}
	return nil
}

func (client *CloudHTTP) Check(ctx context.Context, response *http.Response, message func(string) string) error {
	if response.StatusCode >= 200 && response.StatusCode < 300 || response.StatusCode == http.StatusNotModified {
		return nil
	}
	defer response.Body.Close()
	bytes, err := io.ReadAll(response.Body)
	if err != nil {
		return client.requestError(err)
	}
	text := strings.ToLower(string(bytes))
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusForbidden && response.Header.Get("X-RateLimit-Remaining") == "0" ||
		strings.Contains(text, "rate limit") || strings.Contains(text, "too many requests") {
		return domainerror.New("CI_CLOUD_RATE_LIMITED", cloudProviderLabel(client.key.provider)+" rate limit reached; polling paused.", 503, nil)
	}
	detail := http.StatusText(response.StatusCode)
	var body struct {
		Message any `json:"message"`
	}
	if json.Unmarshal(bytes, &body) == nil {
		if value, ok := body.Message.(string); ok {
			detail = value
		}
	}
	entry, err := client.credentials.resolve(ctx, client.key)
	if err != nil {
		return client.requestError(err)
	}
	if entry.token != "" {
		detail = strings.ReplaceAll(detail, entry.token, "[redacted]")
	}
	if client.key.provider == CloudGitHub {
		detail = "gh: " + detail + " (HTTP " + strconv.Itoa(response.StatusCode) + ")"
	}
	detail = strings.TrimSpace(detail)
	if len(detail) > 300 {
		detail = detail[:300]
	}
	return domainerror.New("CI_CLOUD_FAILED", message(detail), 502, nil)
}

func (client *CloudHTTP) requestError(cause error) error {
	if domain, ok := domainerror.As(cause); ok {
		return domain
	}
	err := domainerror.New("CI_CLOUD_FAILED", cloudProviderLabel(client.key.provider)+" HTTPS request failed.", 502, nil)
	err.Cause = cause
	return err
}

type cloudResponseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (body *cloudResponseBody) Close() error {
	defer body.cancel()
	return body.ReadCloser.Close()
}
