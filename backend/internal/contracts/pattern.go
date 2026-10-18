package contracts

import (
	"fmt"
	"regexp"
	"regexp/syntax"
	"unicode/utf16"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// compileSourcePattern supports the source's flag-free positive ASCII pattern
// language. It does not claim that arbitrary ECMAScript patterns are Go RE2.
// Every consuming atom must match ASCII only, so UTF-16 code units and Unicode
// code points accept the same language. Unsupported dialect features fail closed.
func compileSourcePattern(source string) (*regexp.Regexp, error) {
	inClass := false
	for index := 0; index < len(source); index++ {
		if source[index] >= 0x80 { return nil, fmt.Errorf("pattern contains non-ASCII source") }
		if source[index] != '\\' {
			switch source[index] {
			case '[':
				// Go interprets POSIX classes such as [[:digit:]], whereas the
				// flag-free ECMAScript source has different bracket grammar.
				// Reject nested class openers before Go can reinterpret them.
				if inClass || index+1 < len(source) && source[index+1] == '^' {
					return nil, fmt.Errorf("nested or negated character class needs an ECMAScript adapter")
				}
				inClass = true
			case ']': inClass = false
			case '(':
				if !inClass && index+1 < len(source) && source[index+1] == '?' &&
					(index+2 >= len(source) || source[index+2] != ':') {
					return nil, fmt.Errorf("group mode or lookaround needs an ECMAScript adapter")
				}
			}
			continue
		}
		index++
		if index >= len(source) { return nil, fmt.Errorf("pattern ends with an escape") }
		switch source[index] {
		case 'd', '.', '+', '*', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '/', '-':
		default:
			return nil, fmt.Errorf("pattern escape \\%c needs an ECMAScript adapter", source[index])
		}
	}
	parsed, err := syntax.Parse(source, syntax.Perl)
	if err != nil { return nil, fmt.Errorf("pattern needs an ECMAScript adapter: %w", err) }
	pending := []*syntax.Regexp{parsed}
	for len(pending) > 0 {
		var node *syntax.Regexp
		node, pending = pending[len(pending)-1], pending[:len(pending)-1]
		if node.Flags&syntax.FoldCase != 0 { return nil, fmt.Errorf("pattern case flags need an ECMAScript adapter") }
		switch node.Op {
		case syntax.OpLiteral, syntax.OpCharClass:
			for _, char := range node.Rune {
				if char < 0 || char > 0x7f { return nil, fmt.Errorf("pattern can consume a non-ASCII code point") }
			}
		case syntax.OpEmptyMatch, syntax.OpNoMatch, syntax.OpBeginText, syntax.OpEndText,
			syntax.OpCapture, syntax.OpStar, syntax.OpPlus, syntax.OpQuest, syntax.OpRepeat,
			syntax.OpConcat, syntax.OpAlternate:
		default:
			return nil, fmt.Errorf("pattern operation %s needs an ECMAScript adapter", node.Op)
		}
		pending = append(pending, node.Sub...)
	}
	return regexp.Compile(source)
}

// validationString is an internal predicate projection only. Each unpaired
// surrogate becomes one non-ASCII code point, preserving the source's code-
// point length and the supported positive-ASCII patterns. It is never returned,
// stored, used as identity, or written to a response; the original units remain
// in normalized values and Text. Fixed enum and object keys are checked before
// this bridge and do not use this projection for equality.
func validationString(value jsonvalue.UTF16String) string {
	return string(utf16.Decode(value))
}
