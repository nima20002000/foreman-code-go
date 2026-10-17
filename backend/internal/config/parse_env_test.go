package config_test

import (
	"reflect"
	"testing"

	"github.com/nima20002000/foreman-code-go/backend/internal/config"
)

func TestEnvironmentParserMatchesObservedNodeValues(t *testing.T) {
	// Expectations were observed through node:util.parseEnv in installed Node
	// v24.19.0 and checked against that release's src/node_dotenv.cc parser.
	tests := []struct {
		name  string
		input string
		want  config.Environment
	}{
		{"plain values", "A=one\nB = two  \nC=\n", config.Environment{"A": "one", "B": "two", "C": ""}},
		{"comments", "# comment\nA=one#tail\nB=one # tail\nC=\"one#two\"\n", config.Environment{"A": "one", "B": "one", "C": "one#two"}},
		{"quoted whitespace", "A='  one  '\n", config.Environment{"A": "  one  "}},
		{"double quoted newline", "A=\"one\\ntwo\"\n", config.Environment{"A": "one\ntwo"}},
		{"other escapes unchanged", "A=\"one\\rtwo\\tthree\"\n", config.Environment{"A": "one\\rtwo\\tthree"}},
		{"single quoted backslash", "A='one\\ntwo'\n", config.Environment{"A": "one\\ntwo"}},
		{"backtick multiline", "A=`one\ntwo`\n", config.Environment{"A": "one\ntwo"}},
		{"backslash does not escape quote", "A=\"one\\\"two\"\n", config.Environment{"A": "one\\"}},
		{"unterminated quote", "A=\"not closed\nB=next\n", config.Environment{"A": "\"not closed", "B": "next"}},
		{"quoted suffix ignored", "A=\"one\" trailing words\nB=two\n", config.Environment{"A": "one", "B": "two"}},
		{"duplicate last value", "A=first\nA=last\n", config.Environment{"A": "last"}},
		{"export prefix", "export A=first\nexportB=second\n", config.Environment{"A": "first", "exportB": "second"}},
		{"invalid lines and loose keys", "not a pair\nBAD-NAME=ok\n1A=one\nA B=two\n", config.Environment{"BAD-NAME": "ok", "1A": "one", "A B": "two"}},
		{"whitespace joins following value", "A= \nB=next\n", config.Environment{"A": "B=next"}},
		{"empty value export remains literal", "export A=\nB=next\n", config.Environment{"export A": "", "B": "next"}},
		{"empty key with empty value", "=\nA=one\n", config.Environment{"": "", "A": "one"}},
		{"empty key with value skipped", "=hello\nB=two\n", config.Environment{"B": "two"}},
		{"comment after quoted line", "A=\"one\"\n # fake=ignored\nB=two\n", config.Environment{"A": "one", "# fake": "ignored", "B": "two"}},
		{"carriage returns removed", "A=one\r\nB=hello\rworld\n", config.Environment{"A": "one", "B": "helloworld"}},
		{"prototype setter", "__proto__=ignored\nconstructor=one\ntoString=two\n", config.Environment{"constructor": "one", "toString": "two"}},
		{"unicode whitespace remains", "\vA=one\n\u00A0B=two\n", config.Environment{"\vA": "one", "\u00A0B": "two"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := config.ParseEnv(test.input); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("Parsed environment = %#v, want %#v", got, test.want)
			}
		})
	}
}
