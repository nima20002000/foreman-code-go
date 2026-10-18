package transfer_test

import (
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/transfer"
)

func TestStagingSentinelErrorMessagesAndWrapping(t *testing.T) {
	cases := []struct {
		name    string
		failure error
		message string
	}{
		{"committed bytes", transfer.ErrCommittedBytes, "Committed transfer bytes missing or corrupt; restart byte attempt explicitly"},
		{"chunk", transfer.ErrChunk, "Invalid transfer chunk"},
		{"allocation", transfer.ErrAllocation, "Chunk exceeds allocation"},
		{"offset", transfer.ErrOffset, "Chunk offset conflict"},
		{"duplicate", transfer.ErrDuplicate, "Conflicting duplicate chunk"},
		{"whole integrity", transfer.ErrWholeIntegrity, "Whole transfer integrity mismatch"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := test.failure.Error(); got != test.message {
				t.Fatalf("message = %q, want %q", got, test.message)
			}
			if errors.Unwrap(test.failure) != nil {
				t.Fatal("sentinel acquired an underlying cause")
			}
			wrapped := fmt.Errorf("staging: %w", test.failure)
			if errors.Unwrap(wrapped) != test.failure || !errors.Is(wrapped, test.failure) {
				t.Fatal("wrapping lost the sentinel identity")
			}
			joined := errors.Join(test.failure, io.EOF)
			if got, want := joined.Error(), test.message+"\nEOF"; got != want {
				t.Fatalf("joined message = %q, want %q", got, want)
			}
			if !errors.Is(joined, test.failure) || !errors.Is(joined, io.EOF) {
				t.Fatal("joining lost a cause")
			}
			for _, other := range cases {
				if other.name != test.name && errors.Is(joined, other.failure) {
					t.Fatalf("joining matched unrelated sentinel %q", other.name)
				}
			}
		})
	}
}

func TestStagingValidationErrorsKeepDistinctIdentity(t *testing.T) {
	var directory transfer.StagingDirectory
	cases := []struct {
		name    string
		fail    func() error
		message string
	}{
		{"relative root", func() error {
			_, err := transfer.OpenStagingDirectory("relative", nil)
			return err
		}, "Transfer root must be absolute"},
		{"unsafe root", func() error {
			_, err := transfer.OpenStagingDirectory("/../stage", nil)
			return err
		}, "Unsafe transfer root"},
		{"unsafe name", func() error {
			_, err := directory.OpenPart("../escape", 4, 4)
			return err
		}, "Unsafe staging file name"},
		{"invalid limits", func() error {
			_, err := directory.OpenPart("object", -1, 4)
			return err
		}, "Invalid staging limits"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			first, second := test.fail(), test.fail()
			if first == nil || second == nil {
				t.Fatal("invalid input succeeded")
			}
			if first.Error() != test.message || second.Error() != test.message {
				t.Fatalf("messages = %q, %q; want %q", first, second, test.message)
			}
			if errors.Unwrap(first) != nil || errors.Unwrap(second) != nil {
				t.Fatal("validation error acquired an underlying cause")
			}
			if first == second || errors.Is(first, second) || errors.Is(second, first) {
				t.Fatal("separate validation failures acquired equal identities")
			}
			wrapped := fmt.Errorf("staging: %w", first)
			if errors.Unwrap(wrapped) != first || !errors.Is(wrapped, first) || errors.Is(wrapped, second) {
				t.Fatal("wrapping changed validation error identity")
			}
			if got, want := wrapped.Error(), "staging: "+test.message; got != want {
				t.Fatalf("wrapped message = %q, want %q", got, want)
			}
		})
	}
}
