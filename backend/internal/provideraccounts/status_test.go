package provideraccounts_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
	"github.com/nima20002000/foreman-code-go/backend/internal/provideraccounts"
)

// This opaque test value is deliberately not a copy of a generated subject DTO.
type acceptedSubject struct {
	value string
}

type statusFixture struct {
	selection       provideraccounts.Selection
	result          *provideraccounts.CommandResult
	selectNil       bool
	selectErr       error
	prepareErr      error
	beforeCurrent   bool
	afterCurrent    bool
	beforeErr       error
	afterErr        error
	runErr          error
	closeErr        error
	events          []string
	contexts        []context.Context
	currentCalls    int
	args            []string
	timeout         time.Duration
	runHook         func(context.Context)
	closeHook       func()
	subject         *acceptedSubject
	subjectAccepted bool
	subjectInput    jsonvalue.UTF16String
	qualificationID string
}

func fixture(provider provideraccounts.Provider, result *provideraccounts.CommandResult) *statusFixture {
	f := &statusFixture{
		selection: provideraccounts.Selection{
			Provider:        provider,
			StatusSupported: true,
			QualificationID: "qualified-test-installation",
		},
		result:          result,
		beforeCurrent:   true,
		afterCurrent:    true,
		subject:         &acceptedSubject{value: "accepted by the test adapter"},
		subjectAccepted: true,
	}
	f.selection.IsCurrent = func(ctx context.Context) (bool, error) {
		f.contexts = append(f.contexts, ctx)
		f.currentCalls++
		if f.currentCalls == 1 {
			f.events = append(f.events, "current-before")
			return f.beforeCurrent, f.beforeErr
		}
		f.events = append(f.events, "current-after")
		return f.afterCurrent, f.afterErr
	}
	f.selection.Prepare = func(ctx context.Context, args []string, timeout time.Duration) (provideraccounts.Command, error) {
		f.events = append(f.events, "prepare")
		f.contexts = append(f.contexts, ctx)
		f.args = append([]string(nil), args...)
		f.timeout = timeout
		if f.prepareErr != nil {
			return provideraccounts.Command{}, f.prepareErr
		}
		return provideraccounts.Command{
			Run: func(ctx context.Context) (*provideraccounts.CommandResult, error) {
				f.events = append(f.events, "run")
				f.contexts = append(f.contexts, ctx)
				if f.runHook != nil {
					f.runHook(ctx)
				}
				return f.result, f.runErr
			},
			Close: func() error {
				f.events = append(f.events, "close")
				if f.closeHook != nil {
					f.closeHook()
				}
				return f.closeErr
			},
		}, nil
	}
	return f
}

func (f *statusFixture) ports() provideraccounts.Ports[acceptedSubject] {
	return provideraccounts.Ports[acceptedSubject]{
		Select: func(ctx context.Context) (*provideraccounts.Selection, error) {
			f.events = append(f.events, "select")
			f.contexts = append(f.contexts, ctx)
			if f.selectNil {
				return nil, f.selectErr
			}
			return &f.selection, f.selectErr
		},
		DecodeSubject: func(value jsonvalue.UTF16String, qualificationID string) (*acceptedSubject, bool) {
			f.events = append(f.events, "subject")
			f.subjectInput = append(jsonvalue.UTF16String(nil), value...)
			f.qualificationID = qualificationID
			return f.subject, f.subjectAccepted
		},
	}
}

func commandResult(code int, text string) *provideraccounts.CommandResult {
	return &provideraccounts.CommandResult{Code: &code, Stdout: text}
}

func nativeDomainError() error {
	return domainerror.New("PROVIDER_ACCOUNT_UNQUALIFIED", "The selected native account installation is unavailable.", 409, nil)
}

func assertEvents(t *testing.T, f *statusFixture, want ...string) {
	t.Helper()
	if !reflect.DeepEqual(f.events, want) {
		t.Fatalf("native calls = %v, want %v", f.events, want)
	}
}

func assertUnavailable(t *testing.T, status provideraccounts.Status[acceptedSubject], err, wantErr error) {
	t.Helper()
	if status.State != provideraccounts.Unavailable || status.Identity != nil || status.Subject != nil {
		t.Fatalf("status = %#v, want unavailable without identity or subject", status)
	}
	if err != wantErr {
		t.Fatalf("error = %v, want original identity %v", err, wantErr)
	}
}

func TestReadStatusNativeCommandContract(t *testing.T) {
	for _, test := range []struct {
		provider provideraccounts.Provider
		args     []string
		output   string
	}{
		{provideraccounts.Codex, []string{"login", "status"}, "Logged in using ChatGPT"},
		{provideraccounts.Claude, []string{"auth", "status", "--json"}, `{"loggedIn":true}`},
	} {
		t.Run(string(test.provider), func(t *testing.T) {
			f := fixture(test.provider, commandResult(0, test.output))
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			if err != nil || status.State != provideraccounts.SignedIn || status.Identity != nil || status.Subject != nil {
				t.Fatalf("status = %#v, error = %v", status, err)
			}
			if !reflect.DeepEqual(f.args, test.args) || f.timeout != 15*time.Second {
				t.Fatalf("native command = %v, timeout = %v", f.args, f.timeout)
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
		})
	}
}

func TestReadStatusSelectionUnavailable(t *testing.T) {
	ordinary := errors.New("private selection failure")
	for _, test := range []struct {
		name    string
		nilView bool
		err     error
		wantErr error
	}{
		{"missing", true, nil, nil},
		{"domain", false, nativeDomainError(), nil},
		{"wrapped-domain", false, fmt.Errorf("private wrapper: %w", nativeDomainError()), nil},
		{"ordinary", false, ordinary, ordinary},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Codex, commandResult(0, "Logged in using ChatGPT"))
			f.selectNil, f.selectErr = test.nilView, test.err
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			assertUnavailable(t, status, err, test.wantErr)
			assertEvents(t, f, "select")
		})
	}
}

func TestReadStatusPrepareFailure(t *testing.T) {
	ordinary := errors.New("private reservation failure")
	for _, test := range []struct {
		name    string
		err     error
		wantErr error
	}{
		{"domain", nativeDomainError(), nil},
		{"ordinary", ordinary, ordinary},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Codex, commandResult(0, "Logged in using ChatGPT"))
			f.prepareErr = test.err
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			assertUnavailable(t, status, err, test.wantErr)
			assertEvents(t, f, "select", "prepare")
		})
	}
}

func TestReadStatusPrelaunchGate(t *testing.T) {
	ordinary := errors.New("private prelaunch selection failure")
	for _, test := range []struct {
		name      string
		current   bool
		supported bool
		err       error
		wantErr   error
	}{
		{"stale", false, true, nil, nil},
		{"unsupported", true, false, nil, nil},
		{"recheck-before-support", true, false, ordinary, ordinary},
		{"domain", true, true, nativeDomainError(), nil},
		{"ordinary", true, true, ordinary, ordinary},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Codex, commandResult(0, "Logged in using ChatGPT"))
			f.beforeCurrent, f.beforeErr = test.current, test.err
			f.selection.StatusSupported = test.supported
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			assertUnavailable(t, status, err, test.wantErr)
			assertEvents(t, f, "select", "prepare", "current-before", "close")
		})
	}
}

func TestReadStatusRunFailure(t *testing.T) {
	cause := errors.New("private native command failure")
	ordinary := fmt.Errorf("command context: %w", cause)
	for _, test := range []struct {
		name    string
		err     error
		wantErr error
	}{
		{"domain", nativeDomainError(), nil},
		{"ordinary-wrapped", ordinary, ordinary},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"email":"private@example.test"}`))
			f.runErr = test.err
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			assertUnavailable(t, status, err, test.wantErr)
			if test.wantErr != nil && !errors.Is(err, cause) {
				t.Fatal("native command cause is no longer reachable")
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close")
		})
	}
}

func TestReadStatusCleanupFailurePrecedence(t *testing.T) {
	inspection := errors.New("private inspection failure")
	cleanupCause := errors.New("private cleanup failure")
	cleanup := fmt.Errorf("owner context: %w", cleanupCause)
	for _, test := range []struct {
		name       string
		inspection error
		cleanup    error
		wantErr    error
	}{
		{"successful-read-ordinary-close", nil, cleanup, cleanup},
		{"ordinary-read-ordinary-close", inspection, cleanup, cleanup},
		{"domain-read-ordinary-close", nativeDomainError(), cleanup, cleanup},
		{"successful-read-domain-close", nil, nativeDomainError(), nil},
		{"ordinary-read-domain-close", inspection, nativeDomainError(), nil},
		{"domain-read-domain-close", nativeDomainError(), nativeDomainError(), nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"subject":"private-subject","email":"private@example.test"}`))
			f.selection.SubjectField = "subject"
			f.runErr, f.closeErr = test.inspection, test.cleanup
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			assertUnavailable(t, status, err, test.wantErr)
			if err != nil && (!errors.Is(err, cleanupCause) || errors.Is(err, inspection)) {
				t.Fatal("cleanup did not replace the earlier cause by identity")
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close")
		})
	}
	for _, supported := range []bool{false, true} {
		f := fixture(provideraccounts.Codex, commandResult(0, "Logged in using ChatGPT"))
		f.selection.StatusSupported = supported
		f.beforeCurrent = !supported
		f.closeErr = cleanup
		status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
		assertUnavailable(t, status, err, cleanup)
		assertEvents(t, f, "select", "prepare", "current-before", "close")
	}
}

func TestReadStatusPostCleanupSelection(t *testing.T) {
	ordinary := errors.New("private final selection failure")
	for _, test := range []struct {
		name    string
		current bool
		err     error
		wantErr error
	}{
		{"stale", false, nil, nil},
		{"domain", true, nativeDomainError(), nil},
		{"ordinary", true, ordinary, ordinary},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture(provideraccounts.Claude, commandResult(0, `{"loggedIn":true,"authMethod":{"toString":null},"email":"private@example.test"}`))
			f.afterCurrent, f.afterErr = test.current, test.err
			status, err := provideraccounts.ReadStatus(context.Background(), f.ports())
			assertUnavailable(t, status, err, test.wantErr)
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
		})
	}
}

func TestReadStatusContextAndCleanup(t *testing.T) {
	for _, finalCheckCancels := range []bool{false, true} {
		t.Run(fmt.Sprint(finalCheckCancels), func(t *testing.T) {
			cause := errors.New("caller cancelled during native inspection")
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			f := fixture(provideraccounts.Codex, commandResult(0, "Logged in using ChatGPT"))
			f.runHook = func(context.Context) { cancel(cause) }
			closed := false
			f.closeHook = func() {
				if context.Cause(ctx) != cause {
					t.Fatal("fixture did not reach cancelled cleanup")
				}
				closed = true
			}
			if finalCheckCancels {
				f.afterErr = cause
			}
			status, err := provideraccounts.ReadStatus(ctx, f.ports())
			if !closed {
				t.Fatal("caller cancellation bypassed owned cleanup")
			}
			if finalCheckCancels {
				assertUnavailable(t, status, err, cause)
			} else if err != nil || status.State != provideraccounts.SignedIn {
				t.Fatalf("reader imposed an extra post-cleanup policy: %#v, %v", status, err)
			}
			for _, received := range f.contexts {
				if received != ctx {
					t.Fatal("reader replaced the context passed to a native port")
				}
			}
			assertEvents(t, f, "select", "prepare", "current-before", "run", "close", "current-after")
		})
	}
}
