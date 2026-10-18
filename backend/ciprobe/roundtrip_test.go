package ciprobe

import "testing"

func TestQCIJSONRoundTrip(t *testing.T) {
	actual, err := RoundTrip(Message{Label: "qci-native-fixture", Sequence: 7})
	if err != nil {
		t.Fatalf("round trip returned an error: %v", err)
	}
	expected := Message{Label: "qci-native-fixture", Sequence: 8}
	if actual != expected {
		t.Fatalf("decoded message = %#v, want %#v", actual, expected)
	}
}
