// Package roots implements the filesystem boundaries used by source roots.
package roots

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// RelativePath preserves a root-relative path only when the frozen TypeScript
// rootRelativePath accepts it. The empty path selects the approved base itself.
func RelativePath(path string) (string, error) {
	if path == "" {
		return path, nil
	}
	if !utf8.ValidString(path) || !norm.NFC.IsNormalString(path) ||
		strings.HasPrefix(path, "/") || strings.ContainsAny(path, `\:`) {
		return "", invalidRelativePath()
	}
	units := 0
	for _, character := range path {
		if character < 32 || character == 127 {
			return "", invalidRelativePath()
		}
		units++
		if character > 0xffff {
			units++
		}
	}
	// JavaScript string.length counts UTF-16 code units, not UTF-8 bytes.
	if units > 1024 {
		return "", invalidRelativePath()
	}
	components := strings.Split(path, "/")
	if len(components) > 32 {
		return "", invalidRelativePath()
	}
	for _, component := range components {
		if component == "" || component == "." || component == ".." ||
			strings.HasSuffix(component, ".") || strings.HasSuffix(component, " ") {
			return "", invalidRelativePath()
		}
	}
	return path, nil
}
