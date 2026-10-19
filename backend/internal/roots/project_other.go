//go:build !linux

package roots

func (directory *Directory) OpenProject(path string) (*Directory, error) {
	if _, err := RelativePath(path); err != nil {
		return nil, err
	}
	return nil, unsupportedFilesystem("An approved canonical Linux private root is required.")
}
