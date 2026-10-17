package roots

import "github.com/nima20002000/foreman-code-go/backend/internal/domainerror"

func sourceError(code, message string) error {
	return domainerror.New(code, message, 400, nil)
}

func unsupportedFilesystem(message string) error {
	return domainerror.New("SOURCE_FILESYSTEM_UNSUPPORTED", message, 422, nil)
}

func invalidRelativePath() error {
	return sourceError("ROOT_RELATIVE_PATH_INVALID", "Choose an unambiguous folder relative to an approved base.")
}
