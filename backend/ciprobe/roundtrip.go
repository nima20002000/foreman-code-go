// Package ciprobe exists only on throwaway terminal-CI acceptance branches.
package ciprobe

import "encoding/json"

type Message struct {
	Label    string `json:"label"`
	Sequence int    `json:"sequence"`
}

func RoundTrip(value Message) (Message, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return Message{}, err
	}
	var decoded Message
	err = json.Unmarshal(encoded, &decoded)
	return decoded, err
}
