//go:build !linux

package roots

func OpenPrivateRoot(_ string, _ bool) (*Directory, error) {
	return nil, unsupportedFilesystem("An approved canonical Linux private root is required.")
}

func (directory *Directory) SameDirectory(_ *Directory) (bool, error) {
	return false, unsupportedFilesystem("An approved canonical Linux private root is required.")
}

func (directory *Directory) reopen() (*Directory, error) {
	return nil, unsupportedFilesystem("An approved canonical Linux private root is required.")
}

func (directory *Directory) OpenChild(_ string, _ bool) (*Directory, error) {
	return nil, unsupportedFilesystem("An approved canonical Linux private root is required.")
}
