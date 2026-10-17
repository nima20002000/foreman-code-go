package discovery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DiscoverLauncher inspects only native paths and file contents. It does not
// execute the launcher, load an SDK, or claim readiness for work.
func DiscoverLauncher(ctx context.Context, requested string, environment TargetEnvironment, payloadPaths []string, fingerprints Fingerprinter) (LauncherEvidence, error) {
	evidence := LauncherEvidence{
		Requested: requested, Status: "missing", Diagnostics: []string{},
		Environment: environment, CheckedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if err := ctx.Err(); err != nil {
		return evidence, err
	}
	if fingerprints == nil {
		fingerprints = &inventoryPayloadFingerprints
	}
	directories := []string{}
	for _, directory := range strings.Split(environment.Path, ":") {
		if directory == "" || !filepath.IsAbs(directory) {
			evidence.Diagnostics = append(evidence.Diagnostics, "Ignored empty or relative PATH entry.")
			continue
		}
		directories = append(directories, directory)
	}
	candidates := []string{}
	if strings.Contains(requested, "/") {
		candidate := requested
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(environment.Cwd, candidate)
		}
		candidates = append(candidates, candidate)
	} else {
		for _, directory := range directories {
			candidates = append(candidates, filepath.Join(directory, requested))
		}
	}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return evidence, err
		}
		info, err := os.Lstat(candidate)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				evidence.Status = "unreadable"
				logDiscoveryError("inspect launcher candidate", err)
			}
			continue
		}
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			if info.Mode()&os.ModeSymlink != 0 {
				evidence.Status = "broken-symlink"
			} else {
				evidence.Status = "unreadable"
			}
			logDiscoveryError("resolve launcher candidate", err)
			continue
		}
		resolved, err = filepath.Abs(resolved)
		if err != nil {
			return evidence, err
		}
		if err := executableFile(resolved); err != nil {
			evidence.Status = "not-executable"
			logDiscoveryError("inspect launcher access", err)
			continue
		}
		installed, err := inspectLauncher(ctx, resolved, directories, payloadPaths, fingerprints, &evidence)
		if err != nil {
			if ctx.Err() != nil {
				return evidence, ctx.Err()
			}
			evidence.Status = "unreadable"
			logDiscoveryError("read launcher payload", err)
			continue
		}
		if installed {
			return evidence, nil
		}
	}
	return evidence, nil
}

func inspectLauncher(ctx context.Context, resolved string, directories, payloadPaths []string, fingerprints Fingerprinter, evidence *LauncherEvidence) (bool, error) {
	file, err := os.Open(resolved)
	if err != nil {
		return false, err
	}
	prefix := make([]byte, 4096)
	count, readError := file.Read(prefix)
	if errors.Is(readError, io.EOF) {
		readError = nil
	}
	if err := errors.Join(readError, file.Close()); err != nil {
		return false, err
	}
	firstLine, _, _ := strings.Cut(string(prefix[:count]), "\n")
	if strings.HasPrefix(firstLine, "#!") {
		words := strings.Fields(strings.TrimPrefix(firstLine, "#!"))
		interpreter := ""
		if len(words) > 0 {
			interpreter = words[0]
		}
		evidence.Interpreter = &interpreter
		found, err := inspectInterpreter(words, directories)
		if err != nil {
			evidence.Status = "missing-interpreter"
			evidence.Diagnostics = append(evidence.Diagnostics, "Unavailable shebang interpreter: "+interpreter)
			logDiscoveryError("inspect launcher interpreter", err)
			return false, nil
		}
		evidence.Interpreter = &found
	}
	evidence.ResolvedLauncher = &resolved
	observed := make([]PayloadFingerprint, 0, len(payloadPaths)+1)
	for _, payload := range append([]string{resolved}, payloadPaths...) {
		path, err := filepath.EvalSymlinks(payload)
		if err != nil {
			return false, err
		}
		path, err = filepath.Abs(path)
		if err != nil {
			return false, err
		}
		if err := readableFile(path); err != nil {
			return false, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return false, err
		}
		if !info.Mode().IsRegular() {
			return false, errors.New("Payload is not a file")
		}
		fingerprint, err := fingerprints.Fingerprint(ctx, path, info)
		if err != nil {
			return false, err
		}
		observed = append(observed, PayloadFingerprint{Path: path, Fingerprint: fingerprint})
	}
	fingerprint, err := payloadListFingerprint(observed)
	if err != nil {
		return false, err
	}
	evidence.PayloadFingerprints = observed
	evidence.Fingerprint = &fingerprint
	evidence.Status = "installed"
	return true, nil
}

func inspectInterpreter(words, directories []string) (string, error) {
	if len(words) == 0 || words[0] == "" {
		return "", errors.New("Missing shebang interpreter")
	}
	interpreter := words[0]
	if err := executablePath(interpreter); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(interpreter)
	if err != nil {
		return "", err
	}
	if interpreter != "/usr/bin/env" && interpreter != "/bin/env" && resolved != "/usr/bin/env" && resolved != "/bin/env" {
		return resolved, nil
	}
	if len(words) < 2 || strings.HasPrefix(words[1], "-") {
		return "", errors.New("Unsupported env shebang options")
	}
	for _, directory := range directories {
		path, err := filepath.EvalSymlinks(filepath.Join(directory, words[1]))
		if err == nil {
			err = executableFile(path)
		}
		if err == nil {
			return path, nil
		}
		logDiscoveryError("inspect target interpreter candidate", err)
	}
	return "", errors.New("Missing env interpreter")
}

// The native fingerprint format is JSON.stringify of an ordered payload list,
// not the separate canonical-domain JSON format. Disable Go's HTML escaping;
// JSON.stringify also emits the two JavaScript separator characters literally.
func payloadListFingerprint(payloads []PayloadFingerprint) (string, error) {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payloads); err != nil {
		return "", err
	}
	data := bytes.TrimSuffix(encoded.Bytes(), []byte{'\n'})
	var compatible bytes.Buffer
	for index := 0; index < len(data); index++ {
		if data[index] == '\\' && index+1 < len(data) {
			if index+6 <= len(data) && (string(data[index:index+6]) == `\u2028` || string(data[index:index+6]) == `\u2029`) {
				if data[index+5] == '8' {
					compatible.WriteRune('\u2028')
				} else {
					compatible.WriteRune('\u2029')
				}
				index += 5
				continue
			}
			compatible.WriteByte(data[index])
			index++
		}
		compatible.WriteByte(data[index])
	}
	digest := sha256.Sum256(compatible.Bytes())
	return hex.EncodeToString(digest[:]), nil
}

func logDiscoveryError(operation string, err error) {
	slog.Debug("Native harness discovery observation", "operation", operation, "error", err)
}
