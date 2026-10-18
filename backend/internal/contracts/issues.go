package contracts

import (
	"errors"
	"fmt"
	"slices"

	"github.com/nima20002000/foreman-code-go/backend/internal/canonicaljson"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

var ErrValidation = errors.New("shared contract validation failed")
var ErrUnsupportedSchema = errors.New("shared contract schema needs an explicit runtime adapter")
var ErrSchemaDisagreement = errors.New("generated source adapter and JSON Schema disagree")

// Issue preserves the pinned default safeParse issue boundary. Path entries
// are Text property names or integer array indices. Properties contains the
// source-specific fields such as expected, values, origin, pattern and bounds.
// The message remains lossless even when an unknown key has a lone surrogate.
type Issue struct {
	Code string
	Path []any
	Message Text
	Properties jsonvalue.Object
}

func (issue Issue) JSONValue() any {
	path := make([]any, 0, len(issue.Path))
	for _, item := range issue.Path {
		if text, ok := item.(Text); ok { path = append(path, text.JSONValue()) } else { path = append(path, item) }
	}
	value := slices.Clone(issue.Properties)
	value = append(value, field("code", units(issue.Code)), field("path", path), field("message", issue.Message.JSONValue()))
	return value
}

func (issue Issue) MarshalJSON() ([]byte, error) {
	value, err := canonicaljson.Canonical(issue.JSONValue())
	return []byte(value), err
}

// ValidationError contains every issue in the frozen source's execution order.
// A parser/setup/unsupported-schema error is a different error and never an
// invalid-input result that could qualify a behavioral regression test.
type ValidationError struct {
	SchemaID string
	Issues []Issue
}

func (err *ValidationError) Error() string {
	return fmt.Sprintf("shared contract %s rejected the value with %d issue(s)", err.SchemaID, len(err.Issues))
}

func (err *ValidationError) Unwrap() error { return ErrValidation }

type SchemaSupportError struct {
	SchemaID string
	Path []string
	Reason string
}

func (err *SchemaSupportError) Error() string {
	return fmt.Sprintf("shared contract %s at %v: %s", err.SchemaID, err.Path, err.Reason)
}

func (err *SchemaSupportError) Unwrap() error { return ErrUnsupportedSchema }

func field(key string, value any) jsonvalue.Member { return jsonvalue.Member{Key: units(key), Value: value} }

// All callers supply compiler/source-owned UTF-8 labels, never input text.
func units(value string) jsonvalue.UTF16String {
	result, err := jsonvalue.FromUTF8(value)
	if err != nil { panic("contract source label is not valid UTF-8") }
	return result
}

func makeIssue(code string, message jsonvalue.UTF16String, properties ...jsonvalue.Member) Issue {
	return Issue{Code: code, Path: []any{}, Message: TextFromUTF16(message), Properties: properties}
}

func prefixIssues(path any, issues []rawIssue) []rawIssue {
	for index := range issues {
		issues[index].issue.Path = append([]any{path}, issues[index].issue.Path...)
	}
	return issues
}

type rawIssue struct {
	issue Issue
	// Pinned Zod distinguishes implicit type failure, continuable check issues
	// and explicitly aborting check issues. Length guards may run after an implicit
	// type failure, but do not run after an explicitly aborting check.
	continuation bool
	explicitAbort bool
}

type parsePayload struct {
	value any
	issues []rawIssue
	err error
}

func (payload *parsePayload) aborted() bool {
	for _, issue := range payload.issues { if !issue.continuation { return true } }
	return false
}

func (payload *parsePayload) explicitlyAborted() bool {
	for _, issue := range payload.issues { if issue.explicitAbort { return true } }
	return false
}

func (payload *parsePayload) add(issue Issue, continuation, explicitAbort bool) {
	payload.issues = append(payload.issues, rawIssue{issue: issue, continuation: continuation, explicitAbort: explicitAbort})
}
