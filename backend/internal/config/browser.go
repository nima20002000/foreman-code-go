package config

import (
	"errors"
	"strconv"

	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

func browserOrigin(environment Environment) (string, error) {
	_, hasPort := environment["FOREMAN_CODE_WEB_PORT"]
	port, err := integer(environment, "FOREMAN_CODE_WEB_PORT", 5173, 65535)
	if err != nil {
		return "", errors.New("FOREMAN_CODE_WEB_PORT must be a valid TCP port.")
	}
	legacyValue, hasLegacy := environment["FOREMAN_CODE_DEV_BROWSER_ORIGIN"]
	var legacy *whatwgurl.Url
	if hasLegacy {
		legacy, err = exactBrowserOrigin(legacyValue)
		if err != nil || legacy.Port() == "" {
			return "", errors.New("FOREMAN_CODE_DEV_BROWSER_ORIGIN must be one exact HTTP loopback browser origin, including its port.")
		}
	}
	value, exists := environment["FOREMAN_CODE_BROWSER_ORIGIN"]
	if !exists {
		value = "http://127.0.0.1:" + strconv.FormatInt(port, 10)
		if hasLegacy {
			value = originOf(legacy)
		}
	}
	selected, err := exactBrowserOrigin(value)
	if err != nil {
		return "", err
	}
	if hasLegacy && originOf(selected) != originOf(legacy) {
		return "", errors.New("FOREMAN_CODE_DEV_BROWSER_ORIGIN conflicts with FOREMAN_CODE_BROWSER_ORIGIN.")
	}
	selectedPort := "80"
	if selected.Port() != "" {
		selectedPort = selected.Port()
	}
	if hasPort && selectedPort != strconv.FormatInt(port, 10) {
		return "", errors.New("FOREMAN_CODE_WEB_PORT conflicts with FOREMAN_CODE_BROWSER_ORIGIN.")
	}
	return originOf(selected), nil
}

func originOf(value *whatwgurl.Url) string { return value.Scheme() + "://" + value.Host() }

func exactBrowserOrigin(value string) (*whatwgurl.Url, error) {
	parsed, err := whatwgurl.Parse(value)
	if err == nil && parsed.Scheme() == "http" && loopbackURLHost(parsed.Hostname()) &&
		parsed.Username() == "" && parsed.Password() == "" && parsed.Pathname() == "/" &&
		parsed.Search() == "" && parsed.Hash() == "" {
		return parsed, nil
	}
	return nil, errors.New("FOREMAN_CODE_BROWSER_ORIGIN must be an exact HTTP loopback browser origin.")
}

func loopbackURLHost(host string) bool {
	return host == "127.0.0.1" || host == "[::1]" || host == "localhost"
}
