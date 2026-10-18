package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync/atomic"

	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex"
	"github.com/nima20002000/foreman-code-go/backend/internal/harnesses/codex/protocol"
	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// ReadCodex reads all native metadata pages and publishes only after successful
// validation, installation recheck, physical cleanup and caller-cancellation check.
// It does not create a thread, run inference, answer native approvals or select a
// model. Shared API translation and admission remain outside this native boundary.
func ReadCodex(ctx context.Context, inspection Inspection, directory string, environment map[string]string) (jsonvalue.Object, error) {
	if inspection.AssertUnchanged == nil || inspection.RunCommand == nil || inspection.Open == nil {
		return nil, errors.New("codex model inspection requires qualified installation and owned process ports")
	}
	if err := inspection.AssertUnchanged(ctx); err != nil {
		return nil, err
	}
	metadataEnvironment := inheritedEnvironment(environment)
	listed, err := inspection.RunCommand(ctx, Command{Binary: inspection.Binary,
		Arguments: []string{"mcp", "list", "--json"}, Directory: directory, Environment: metadataEnvironment})
	if err != nil {
		return nil, err
	}
	disabled, err := configuredExclusions(listed)
	if err != nil {
		return nil, err
	}
	var session Session
	var refreshFailed atomic.Bool
	options := OpenOptions{Binary: inspection.Binary, Directory: directory,
		Environment: inheritedEnvironment(metadataEnvironment), DisabledMCPNames: disabled,
		OnRequest: func(active context.Context, request codex.Request) error {
			return session.Reject(active, request.ID, -32601, "Model inspection cannot answer native requests.")
		},
		OnRefreshFailure: func() { refreshFailed.Store(true) },
	}
	options.Environment["RUST_LOG"] = "codex_models_manager=error,codex_core::models_manager=error"
	session, err = inspection.Open(ctx, options)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errors.New("codex model inspection requires an owned native session")
	}
	catalog, failure := inspectPages(ctx, session, inspection.AssertUnchanged)
	var native *Error
	if errors.As(failure, &native) && native.Code == "CODEX_MODEL_CATALOG_INVALID" {
		failure = &Error{Code: native.Code, Message: "Codex " + inspection.ProviderVersion +
			" does not satisfy the model/list catalog response contract.", cause: failure}
	}
	cleanup := session.Close()
	if cleanup != nil {
		if failure != nil {
			return nil, &CleanupError{InspectionCause: failure, CleanupCause: cleanup}
		}
		return nil, cleanup
	}
	if failure != nil {
		return nil, failure
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if refreshFailed.Load() {
		reportRefreshFailure()
		catalog = setProperty(catalog, "modelCatalogSource", text("cached"))
	}
	return catalog, nil
}

func inspectPages(ctx context.Context, session Session, assertUnchanged func(context.Context) error) (jsonvalue.Object, error) {
	if err := session.Start(ctx); err != nil {
		return nil, err
	}
	models := []any{}
	cursors := map[string]struct{}{}
	cursor := ""
	for {
		params := protocol.V2ModelListParams{IncludeHidden: protocol.Some(true), Limit: protocol.Some(uint32(100))}
		if cursor != "" {
			params.Cursor = protocol.Some(cursor)
		}
		page, err := session.ListModels(ctx, params)
		if err != nil {
			return nil, err
		}
		if page.Data == nil {
			return nil, invalidCatalog(nil)
		}
		for _, model := range page.Data {
			value, err := projectModel(model, len(models))
			if err != nil {
				return nil, err
			}
			models = append(models, value)
		}
		cursor, _, _ = page.NextCursor.Value()
		_, repeated := cursors[cursor]
		if len(models) > maxModels || cursor != "" && (len(page.Data) == 0 || repeated) {
			return nil, invalidCatalog(nil)
		}
		if cursor == "" {
			break
		}
		cursors[cursor] = struct{}{}
	}
	if err := assertUnchanged(ctx); err != nil {
		return nil, err
	}
	catalog := jsonvalue.Object{{Key: text("models"), Value: models}}
	if err := validateCatalog(catalog); err != nil {
		return nil, err
	}
	return catalog, nil
}

func projectModel(model *protocol.V2Model, priority int) (jsonvalue.Object, error) {
	if model == nil || model.SupportedReasoningEfforts == nil {
		return nil, invalidCatalog(nil)
	}
	slug, err := jsonvalue.FromUTF8(model.Model)
	if err != nil {
		return nil, invalidCatalog(err)
	}
	displayName, err := jsonvalue.FromUTF8(model.DisplayName)
	if err != nil {
		return nil, invalidCatalog(err)
	}
	levels := []any{}
	for _, value := range model.SupportedReasoningEfforts {
		if value == nil {
			return nil, invalidCatalog(nil)
		}
		effort, err := jsonvalue.FromUTF8(string(value.ReasoningEffort))
		if err != nil {
			return nil, invalidCatalog(err)
		}
		levels = append(levels, jsonvalue.Object{{Key: text("effort"), Value: effort}})
	}
	visibility := "list"
	if model.Hidden {
		visibility = "hide"
	}
	result := jsonvalue.Object{
		{Key: text("slug"), Value: slug}, {Key: text("display_name"), Value: displayName},
		{Key: text("visibility"), Value: text(visibility)}, {Key: text("priority"), Value: json.Number(strconv.Itoa(priority))},
		{Key: text("supported_reasoning_levels"), Value: levels},
	}
	tiers, present, null := model.AdditionalSpeedTiers.Value()
	if present {
		var value any
		if !null && tiers != nil {
			items := []any{}
			for _, tier := range tiers {
				item, err := jsonvalue.FromUTF8(tier)
				if err != nil {
					return nil, invalidCatalog(err)
				}
				items = append(items, item)
			}
			value = items
		}
		result = append(result, jsonvalue.Member{Key: text("additional_speed_tiers"), Value: value})
	}
	return result, nil
}
