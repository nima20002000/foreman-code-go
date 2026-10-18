package canonicaljson

// NumericKeysFirstLegacy implements the frozen shared
// canonicalJsonNumericKeysFirstLegacy format. It writes array-index property
// names first in numeric order, then the remaining names in UTF-16 order, at
// every object depth. A top-level Undefined produces "null".
//
// Use this only for existing identities that call the matching TypeScript
// serializer, including Codex plugin catalog/source/artifact hashes. New
// identities use Canonical. This does not implement locale-order legacy hashes.
// The supported Go value representations are the same as Canonical.
func NumericKeysFirstLegacy(value any) (string, error) {
	if _, undefined := value.(undefinedValue); undefined {
		return "null", nil
	}
	e := encoder{
		numericKeysFirst: true,
		limit:            int64(^uint64(0) >> 1),
		active:           make(map[identity]bool),
	}
	if err := e.value(value, 0); err != nil {
		return "", err
	}
	return e.out.String(), nil
}

func legacyKeyLess(left, right UTF16String) bool {
	leftIndex, leftIsIndex := left.ArrayIndex()
	rightIndex, rightIsIndex := right.ArrayIndex()
	if leftIsIndex != rightIsIndex {
		return leftIsIndex
	}
	if leftIsIndex {
		return leftIndex < rightIndex
	}
	return compareUnits(left, right) < 0
}
