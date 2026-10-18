package jsonvalue

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

var ErrSyntax = errors.New("invalid JSON")

// SyntaxError gives a zero-based byte offset in the supplied UTF-8 document.
// Transport adapters own the public HTTP error text; this is not a promise to
// reproduce a particular JavaScript engine's SyntaxError wording.
type SyntaxError struct {
	Offset int
	Reason string
}

func (err *SyntaxError) Error() string {
	return fmt.Sprintf("invalid JSON at byte %d: %s", err.Offset, err.Reason)
}

func (err *SyntaxError) Unwrap() error { return ErrSyntax }

type state uint8

const (
	arrayFirst state = iota
	arrayValue
	arrayNext
	objectFirst
	objectKey
	objectColon
	objectValue
	objectNext
)

type frame struct {
	kind      byte
	state     state
	array     []any
	object    Object
	positions map[string]int
	key       UTF16String
}

type parser struct {
	data     []byte
	offset   int
	frames   []frame
	root     any
	complete bool
}

// Parse accepts exactly one JSON value in valid UTF-8. It preserves strings and
// object keys as UTF16String, numbers as json.Number, arrays as []any, booleans
// as bool and null as nil. Containers are parsed iteratively, without a fixed
// nesting limit. The caller owns byte/resource admission and transport UTF-8/BOM
// normalization. Reserved property-name policy is not part of JSON grammar.
func Parse(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, &SyntaxError{Reason: "input requires valid UTF-8"}
	}
	p := parser{data: data}
	for {
		p.space()
		if len(p.frames) == 0 {
			if p.complete {
				if p.offset != len(p.data) {
					return nil, p.invalid("unexpected data after the JSON value")
				}
				return p.root, nil
			}
			if err := p.value(); err != nil {
				return nil, err
			}
			continue
		}
		current := &p.frames[len(p.frames)-1]
		switch current.state {
		case arrayFirst:
			if p.take(']') {
				p.close()
				continue
			}
			fallthrough
		case arrayValue, objectValue:
			if err := p.value(); err != nil {
				return nil, err
			}
		case objectFirst:
			if p.take('}') {
				p.close()
				continue
			}
			fallthrough
		case objectKey:
			key, err := p.string()
			if err != nil {
				return nil, err
			}
			current.key, current.state = key, objectColon
		case objectColon:
			if !p.take(':') {
				return nil, p.invalid("expected a colon after an object key")
			}
			current.state = objectValue
		case arrayNext:
			if p.take(']') {
				p.close()
			} else if p.take(',') {
				current.state = arrayValue
			} else {
				return nil, p.invalid("expected a comma or array end")
			}
		case objectNext:
			if p.take('}') {
				p.close()
			} else if p.take(',') {
				current.state = objectKey
			} else {
				return nil, p.invalid("expected a comma or object end")
			}
		}
	}
}

func (p *parser) value() error {
	if p.offset == len(p.data) {
		return p.invalid("expected a JSON value")
	}
	var value any
	var err error
	switch p.data[p.offset] {
	case '{':
		p.offset++
		p.frames = append(p.frames, frame{kind: '{', state: objectFirst,
			object: make(Object, 0), positions: make(map[string]int)})
		return nil
	case '[':
		p.offset++
		p.frames = append(p.frames, frame{kind: '[', state: arrayFirst, array: make([]any, 0)})
		return nil
	case '"':
		value, err = p.string()
	case 't':
		if !p.literal("true") {
			return p.invalid("expected true")
		}
		value = true
	case 'f':
		if !p.literal("false") {
			return p.invalid("expected false")
		}
		value = false
	case 'n':
		if !p.literal("null") {
			return p.invalid("expected null")
		}
	default:
		value, err = p.number()
	}
	if err != nil {
		return err
	}
	p.attach(value)
	return nil
}

func (p *parser) attach(value any) {
	if len(p.frames) == 0 {
		p.root, p.complete = value, true
		return
	}
	current := &p.frames[len(p.frames)-1]
	if current.kind == '[' {
		current.array = append(current.array, value)
		current.state = arrayNext
		return
	}
	key := current.key.IdentityKey()
	if position, present := current.positions[key]; present {
		current.object[position].Value = value
	} else {
		current.positions[key] = len(current.object)
		current.object = append(current.object, Member{Key: current.key, Value: value})
	}
	current.key, current.state = nil, objectNext
}

func (p *parser) close() {
	last := len(p.frames) - 1
	current := p.frames[last]
	p.frames[last] = frame{}
	p.frames = p.frames[:last]
	if current.kind == '[' {
		p.attach(current.array)
		return
	}
	sort.SliceStable(current.object, func(left, right int) bool {
		a, aIndex := current.object[left].Key.ArrayIndex()
		b, bIndex := current.object[right].Key.ArrayIndex()
		if aIndex && bIndex {
			return a < b
		}
		return aIndex && !bIndex
	})
	p.attach(current.object)
}

func (p *parser) space() {
	for p.offset < len(p.data) {
		switch p.data[p.offset] {
		case ' ', '\t', '\r', '\n':
			p.offset++
		default:
			return
		}
	}
}

func (p *parser) take(value byte) bool {
	if p.offset < len(p.data) && p.data[p.offset] == value {
		p.offset++
		return true
	}
	return false
}

func (p *parser) literal(value string) bool {
	if len(p.data)-p.offset < len(value) || string(p.data[p.offset:p.offset+len(value)]) != value {
		return false
	}
	p.offset += len(value)
	return true
}

func (p *parser) invalid(reason string) error {
	return &SyntaxError{Offset: p.offset, Reason: reason}
}

func (p *parser) number() (json.Number, error) {
	start := p.offset
	p.take('-')
	if !p.take('0') {
		if p.offset == len(p.data) || p.data[p.offset] < '1' || p.data[p.offset] > '9' {
			return "", p.invalid("expected a JSON number or value")
		}
		p.digits()
	}
	if p.take('.') {
		if !p.digits() {
			return "", p.invalid("expected digits after the decimal point")
		}
	}
	if p.take('e') || p.take('E') {
		if !p.take('+') {
			p.take('-')
		}
		if !p.digits() {
			return "", p.invalid("expected exponent digits")
		}
	}
	return json.Number(p.data[start:p.offset]), nil
}

func (p *parser) digits() bool {
	start := p.offset
	for p.offset < len(p.data) && p.data[p.offset] >= '0' && p.data[p.offset] <= '9' {
		p.offset++
	}
	return p.offset != start
}
