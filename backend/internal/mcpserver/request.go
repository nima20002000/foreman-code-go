package mcpserver

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/nima20002000/foreman-code-go/backend/internal/domainerror"
)

// requestedTool reads only JSON-RPC transport fields; domain inputs use generated validators.
func requestedTool(w http.ResponseWriter, request *http.Request, limit int64) (string, []byte, error) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return "", nil, domainerror.New("UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported.", 415, nil)
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, request.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return "", nil, domainerror.New("REQUEST_TOO_LARGE", "The request body exceeds the allowed size.", 413, nil)
		}
		return "", nil, err
	}
	if err := request.Body.Close(); err != nil {
		return "", nil, err
	}
	request.Body = io.NopCloser(bytes.NewReader(data))
	if !json.Valid(data) {
		return "", nil, domainerror.New("INVALID_REQUEST", "The request body must contain valid JSON.", 400, nil)
	}
	var call struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if err := json.Unmarshal(data, &call); err != nil {
		// Valid JSON with the wrong RPC shape belongs to the SDK's protocol error boundary.
		return "", data, nil
	}
	if call.Method == "tools/call" {
		return call.Params.Name, data, nil
	}
	return "", data, nil
}
