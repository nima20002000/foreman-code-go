package cihost

import (
	"net/url"
	"os"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// CloudProviderKind identifies the external API protocol, not a CI domain DTO.
type CloudProviderKind string

const (
	CloudGitHub   CloudProviderKind = "github"
	CloudCircleCI CloudProviderKind = "circleci"
)

// ResolveCloudAPIBaseURL keeps production defaults and permits an isolated fake API.
// The same environment names must be provided by the frozen TS target's override.
func ResolveCloudAPIBaseURL(provider CloudProviderKind, override string, lookup func(string) (string, bool)) (string, error) {
	var endpoint, key string
	switch provider {
	case CloudGitHub:
		endpoint, key = "https://api.github.com", "FOREMAN_CI_GITHUB_API_BASE_URL"
	case CloudCircleCI:
		endpoint, key = "https://circleci.com", "FOREMAN_CI_CIRCLECI_BASE_URL"
	default:
		return "", domainerror.New("CI_CLOUD_FAILED", "The cloud CI provider is invalid.", 502, nil)
	}
	if lookup == nil {
		lookup = os.LookupEnv
	}
	if configured, ok := lookup(key); ok && configured != "" {
		endpoint = configured
	}
	if override != "" {
		endpoint = override
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", domainerror.New("CI_CLOUD_FAILED", cloudProviderLabel(provider)+" API endpoint is invalid.", 502, nil)
	}
	return strings.TrimRight(endpoint, "/"), nil
}

func cloudProviderLabel(provider CloudProviderKind) string {
	if provider == CloudGitHub {
		return "GitHub Actions"
	}
	return "CircleCI"
}
