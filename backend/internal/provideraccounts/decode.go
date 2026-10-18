package provideraccounts

import (
	"errors"
	"strings"

	"github.com/nima20002000/foreman-code-go/backend/internal/jsonvalue"
)

func decodeStatus[SubjectValue any](ports Ports[SubjectValue], selection Selection, result *CommandResult) (Status[SubjectValue], error) {
	unavailable := Status[SubjectValue]{State: Unavailable}
	if result == nil || result.TimedOut || result.Code == nil {
		return unavailable, nil
	}
	if selection.Provider == Codex {
		text := asciiLower(result.Stdout)
		if *result.Code == 0 && strings.Contains(text, "logged in using chatgpt") {
			return Status[SubjectValue]{State: SignedIn}, nil
		}
		if strings.TrimFunc(text, jsWhitespace) == "not logged in" {
			return Status[SubjectValue]{State: SignedOut}, nil
		}
		return unavailable, nil
	}
	if *result.Code != 0 {
		return unavailable, nil
	}
	value, err := jsonvalue.Parse([]byte(result.Stdout))
	if err != nil {
		return unavailable, nil
	}
	object, ok := value.(jsonvalue.Object)
	if !ok {
		return unavailable, nil
	}
	loggedIn, _ := nativeProperty(object, "loggedIn")
	if loggedIn == false {
		return Status[SubjectValue]{State: SignedOut}, nil
	}
	if loggedIn != true {
		return unavailable, nil
	}
	authMethod, _ := nativeProperty(object, "authMethod")
	apiKey, err := apiKeyAuthMethod(authMethod)
	if err != nil {
		return unavailable, err
	}
	if apiKey {
		return unavailable, nil
	}

	status := Status[SubjectValue]{State: SignedIn}
	if email, _ := nativeProperty(object, "email"); email != nil {
		if text, ok := email.(jsonvalue.UTF16String); ok && safeIdentity(text) {
			status.Identity = text
		}
	}
	if selection.SubjectField == "" {
		return status, nil
	}
	value, _ = nativeProperty(object, selection.SubjectField)
	subject, ok := value.(jsonvalue.UTF16String)
	if !ok || hasNativeControl(subject) {
		return status, nil
	}
	if ports.DecodeSubject == nil {
		return unavailable, errors.New("native account subject decoder is required for a qualified subject candidate")
	}
	if decoded, accepted := ports.DecodeSubject(subject, selection.QualificationID); accepted {
		status.Subject = decoded
	}
	return status, nil
}

func nativeProperty(object jsonvalue.Object, key string) (any, bool) {
	for _, member := range object {
		if asciiTextEqual(member.Key, key) {
			return member.Value, true
		}
	}
	return nil, false
}
