package cihost

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

func (client *CloudHTTP) Download(ctx context.Context, response *http.Response, timeout time.Duration) ([]byte, error) {
	defer response.Body.Close()
	location := response.Header.Get("Location")
	if response.StatusCode >= 300 && response.StatusCode < 400 && location != "" {
		return client.DownloadURL(ctx, location, timeout)
	}
	if err := client.Check(ctx, response, func(string) string { return client.downloadMessage() }); err != nil {
		return nil, err
	}
	bytes, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, client.downloadError(err)
	}
	return bytes, nil
}

// DownloadURL uses a separate client without API headers or a credential jar.
// Signed log/artifact URLs and every redirect remain credential-free.
func (client *CloudHTTP) DownloadURL(ctx context.Context, target string, timeout time.Duration) ([]byte, error) {
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, client.downloadError(err)
	}
	response, err := client.download.Do(request)
	if err != nil {
		return nil, client.downloadError(err)
	}
	defer response.Body.Close()
	if err := client.Check(ctx, response, func(string) string { return client.downloadMessage() }); err != nil {
		return nil, err
	}
	bytes, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, client.downloadError(err)
	}
	return bytes, nil
}

func (client *CloudHTTP) downloadMessage() string {
	return cloudProviderLabel(client.key.provider) + " artifacts could not be downloaded."
}

func (client *CloudHTTP) downloadError(cause error) error {
	if domain, ok := domainerror.As(cause); ok {
		return domain
	}
	err := domainerror.New("CI_CLOUD_FAILED", client.downloadMessage(), 502, nil)
	err.Cause = cause
	return err
}
