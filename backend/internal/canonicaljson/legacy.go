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
		limit: int64(^uint64(0) >> 1),
		active: make(map[identity]bool),
	}
	if err := e.value(value, 0); err != nil {
		return "", err
	}
	return e.out.String(), nil
}

func legacyKeyLess(left, right UTF16String) bool {
	leftIndex, leftIsIndex := arrayIndexKey(left)
	rightIndex, rightIsIndex := arrayIndexKey(right)
	if leftIsIndex != rightIsIndex {
		return leftIsIndex
	}
	if leftIsIndex {
		return leftIndex < rightIndex
	}
	return compareUnits(left, right) < 0
}

// ECMAScript array-index keys have their exact unsigned decimal spelling and
// are smaller than 2^32-1. In particular, -0, 00 and 4294967295 are not indices.
func arrayIndexKey(key UTF16String) (uint64, bool) {
	if len(key) == 0 || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	var value uint64
	for _, unit := range key {
		if unit < '0' || unit > '9' {
			return 0, false
		}
		value = value*10 + uint64(unit-'0')
	}
	return value, value < 1<<32-1
}
