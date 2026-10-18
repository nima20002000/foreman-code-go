package contracts

import (
	"fmt"
	"slices"
	"sort"
)

func validateManifest(source *manifest) error {
	failure := func(reason string) error { return &SchemaSupportError{Reason: reason} }
	if source.SchemaVersion != 1 || source.Draft != "2020-12" || source.Source.Package != "@foreman-code/contracts" ||
		source.Source.Reference != FrozenReference || source.Source.MergedBase != MergedBase || source.Source.ZodVersion != "4.6.3" ||
		!gitSHA(source.Source.Candidate) || !gitSHA(source.Source.Tree) || !gitSHA(source.Source.ContractsTree) {
		return failure("manifest source/version identity is missing or differs from the frozen contract boundary")
	}
	for key, expected := range map[string]string{
		"valueDomain": "JSON", "normalization": "before-json-schema", "format": "annotation-with-source-pattern",
		"stringLength": "unicode-code-points", "stringRepresentation": "lossless-utf16", "patternDialect": "ecmascript-no-flags",
		"runtimeQualification": "requires-separate-terminal-parity-evidence",
		"execution": "zod-default-en",
	} {
		if source.Validation[key] != expected { return failure(fmt.Sprintf("unsupported validation policy %s", key)) }
	}
	if len(source.Schemas) == 0 || len(source.Unsupported) != 0 || len(source.Coverage.Unsupported) != 0 {
		return failure("every explicitly selected schema must export with supported execution metadata")
	}
	ids := make([]string, 0, len(source.Schemas))
	seen := map[string]bool{}
	for _, schema := range source.Schemas {
		if schema.ID == "" || schema.ID != schema.Module+"#"+schema.Export || schema.Module == "" || schema.Export == "" || seen[schema.ID] {
			return failure("duplicate or invalid selected schema identity")
		}
		seen[schema.ID] = true
		ids = append(ids, schema.ID)
	}
	sort.Strings(ids)
	selected, exported := slices.Clone(source.Coverage.Selected), slices.Clone(source.Coverage.Exported)
	sort.Strings(selected)
	sort.Strings(exported)
	if !slices.Equal(ids, selected) || !slices.Equal(ids, exported) { return failure("selected/exported coverage differs from the supplied runtime roots") }
	return nil
}

func gitSHA(value string) bool {
	return lowerHex(value, 40)
}

func lowerHex(value string, length int) bool {
	if len(value) != length { return false }
	for _, char := range value { if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') { return false } }
	return true
}

func (locale executionLocale) supported() bool {
	return locale.Repository == "colinhacks/zod" && locale.Reference == "v4.6.3" &&
		locale.SourceFile == "packages/zod/src/v4/locales/en.ts" && locale.SourceBlob == "3836bd1651071082fb24488d4e3b3d29db851134" &&
		locale.InstalledFile == "v4/locales/en.js" && lowerHex(locale.InstalledSHA256, 64) && locale.ModuleFormat == "esm" &&
		locale.Binding == "exporter-created-factory-policy" &&
		(locale.Phase == "before-selected-module-imports" || locale.Phase == "explicit-public-binding")
}
