package contracts

import (
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

// valueDecoder keeps decoded JavaScript numbers and UTF-16 units intact while
// filling generated Go values. It avoids an intervening JSON stringify, which
// would turn negative zero into positive zero before typed readback.
type valueDecoder interface {
	decodeContractValue(any) error
}

func (value *Text) decodeContractValue(input any) error {
	units, ok := input.(jsonvalue.UTF16String)
	if !ok { return errors.New("decoded contract string has an incompatible representation") }
	*value = TextFromUTF16(units)
	return nil
}

func (value *Optional[T]) decodeContractValue(input any) error {
	var decoded T
	if err := assignValue(reflect.ValueOf(&decoded).Elem(), input); err != nil { return err }
	*value = Some(decoded)
	return nil
}

func (value *Nullable[T]) decodeContractValue(input any) error {
	if input == nil {
		*value = Nullable[T]{}
		return nil
	}
	var decoded T
	if err := assignValue(reflect.ValueOf(&decoded).Elem(), input); err != nil { return err }
	*value = Present(decoded)
	return nil
}

func decodeValue(destination any, input any) error {
	value := reflect.ValueOf(destination)
	if !value.IsValid() || value.Kind() != reflect.Pointer || value.IsNil() {
		return errors.New("contract decode requires a non-nil pointer")
	}
	// Fresh allocation resets absent optional fields and leaves the original
	// destination unchanged on any validation or representation error.
	fresh := reflect.New(value.Elem().Type()).Elem()
	if err := assignValue(fresh, input); err != nil { return err }
	value.Elem().Set(fresh)
	return nil
}

func assignValue(target reflect.Value, input any) error {
	if target.CanAddr() && target.Addr().CanInterface() {
		if decoder, ok := target.Addr().Interface().(valueDecoder); ok {
			return decoder.decodeContractValue(input)
		}
	}
	switch target.Kind() {
	case reflect.String:
		units, ok := input.(jsonvalue.UTF16String)
		if !ok { break }
		text, err := units.UTF8()
		if err != nil { return err }
		target.SetString(text)
		return nil
	case reflect.Float64:
		value, ok := input.(float64)
		if !ok { break }
		target.SetFloat(value)
		return nil
	case reflect.Bool:
		value, ok := input.(bool)
		if !ok { break }
		target.SetBool(value)
		return nil
	case reflect.Slice:
		values, ok := input.([]any)
		if !ok { break }
		output := reflect.MakeSlice(target.Type(), len(values), len(values))
		for index, value := range values {
			if err := assignValue(output.Index(index), value); err != nil {
				return fmt.Errorf("decode array element %d: %w", index, err)
			}
		}
		target.Set(output)
		return nil
	case reflect.Struct:
		object, ok := input.(jsonvalue.Object)
		if !ok { break }
		return assignObject(target, object)
	}
	return fmt.Errorf("decoded contract value cannot populate %s", target.Type())
}

func assignObject(target reflect.Value, object jsonvalue.Object) error {
	fields := make(map[string]int, target.NumField())
	for index := 0; index < target.NumField(); index++ {
		field := target.Type().Field(index)
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if field.Anonymous || field.PkgPath != "" || name == "" || name == "-" {
			return fmt.Errorf("contract destination field %s is not an explicit generated JSON field", field.Name)
		}
		key, err := jsonvalue.FromUTF8(name)
		if err != nil { return err }
		if _, exists := fields[key.IdentityKey()]; exists { return errors.New("duplicate destination JSON field") }
		fields[key.IdentityKey()] = index
	}
	for _, member := range object {
		index, exists := fields[member.Key.IdentityKey()]
		if !exists { return errors.New("contract destination omits a decoded JSON field") }
		if err := assignValue(target.Field(index), member.Value); err != nil {
			return fmt.Errorf("decode field %s: %w", target.Type().Field(index).Name, err)
		}
	}
	return nil
}
