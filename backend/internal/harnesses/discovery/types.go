// Package discovery observes host-local native launchers without starting them.
// These are filesystem port values, not copies of the shared API contracts.
package discovery

import (
	"context"
	"os"
)

// TargetEnvironment is the owning host's captured environment. Discovery never
// searches the observer's working directory or inherits its PATH.
type TargetEnvironment struct {
	Generation string `json:"generation"`
	Provenance string `json:"provenance"`
	Cwd        string `json:"cwd"`
	Path       string `json:"path"`
}

// PayloadFingerprint identifies bytes observed at one resolved native path.
type PayloadFingerprint struct {
	Path        string `json:"path"`
	Fingerprint string `json:"fingerprint"`
}

// LauncherEvidence is passive evidence, never a qualification or admission.
// Nil fields have the same meaning as the frozen native discovery port's nulls.
type LauncherEvidence struct {
	Requested           string               `json:"requested"`
	ResolvedLauncher    *string              `json:"resolvedLauncher"`
	Fingerprint         *string              `json:"fingerprint"`
	PayloadFingerprints []PayloadFingerprint `json:"payloadFingerprints,omitempty"`
	Status              string               `json:"status"`
	Interpreter         *string              `json:"interpreter"`
	Diagnostics         []string             `json:"diagnostics"`
	Environment         TargetEnvironment    `json:"environment"`
	CheckedAt           string               `json:"checkedAt"`
}

// Fingerprinter is the native byte-observation port. The optional observation
// binds the digest to the file identity already inspected by discovery.
type Fingerprinter interface {
	Fingerprint(context.Context, string, os.FileInfo) (string, error)
}
