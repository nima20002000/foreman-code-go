package devices

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

var (
	ErrDeviceTLSFileSymlink     = errors.New("Device TLS files must not use symbolic links.")
	ErrDeviceTLSFilePermissions = errors.New("Device TLS files must be owner-only regular files owned by Main’s OS user.")
)

// DeviceTLSFile is one opened native descriptor. Stat, Read and Close act on
// that descriptor, never by reopening the pathname.
type DeviceTLSFile interface {
	io.Reader
	io.Closer
	Stat() (os.FileInfo, error)
}

// DeviceTLSFileSystem is the native filesystem boundary used to inject
// descriptor failures. Open must be read-only, no-follow and nonblocking.
type DeviceTLSFileSystem interface {
	RealPath(string) (string, error)
	Open(string) (DeviceTLSFile, error)
}

// NativeDeviceTLSFileSystem uses the process filesystem and current OS user.
type NativeDeviceTLSFileSystem struct{}

func (NativeDeviceTLSFileSystem) RealPath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	return filepath.Abs(resolved)
}

func (NativeDeviceTLSFileSystem) Open(path string) (DeviceTLSFile, error) {
	return openDeviceTLSFile(path)
}

// DeviceTLSFileReader reads already-approved local material. Its zero value
// uses the native filesystem; it grants no device or listener authority.
type DeviceTLSFileReader struct {
	FileSystem DeviceTLSFileSystem
}

// ReadOwnedDeviceTLSFile preserves the frozen private-file gate, including
// the 64 KiB limit on the descriptor's initial size. Like the frozen readFile
// call, it does not claim a size bound under concurrent file growth.
func ReadOwnedDeviceTLSFile(path string) ([]byte, error) {
	return (DeviceTLSFileReader{}).ReadOwned(path)
}

func (reader DeviceTLSFileReader) ReadOwned(path string) (material []byte, err error) {
	filesystem := reader.FileSystem
	if filesystem == nil {
		filesystem = NativeDeviceTLSFileSystem{}
	}
	canonical, err := filesystem.RealPath(path)
	if err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if canonical != absolute {
		return nil, ErrDeviceTLSFileSymlink
	}
	file, err := filesystem.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() {
		// The frozen awaited finally overrides an earlier stat/read failure.
		if closeErr := file.Close(); closeErr != nil {
			material, err = nil, closeErr
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !deviceTLSFileOwned(info) || info.Mode().Perm()&0o077 != 0 || info.Size() > 65536 {
		return nil, ErrDeviceTLSFilePermissions
	}
	material, err = io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	return material, nil
}

// ReadDeviceTLSMaterials closes the certificate descriptor before opening the
// private key, then validates the materials. advertisedHostname is the normalized
// WHATWG endpoint hostname with IPv6 brackets removed; empty means omitted.
// Endpoint configuration and public DeviceTlsTrust adaptation remain outside
// this native core.
func ReadDeviceTLSMaterials(certificatePath, privateKeyPath, advertisedHostname string) (*DeviceTLSMaterials, error) {
	return (DeviceTLSFileReader{}).ReadMaterials(certificatePath, privateKeyPath, advertisedHostname)
}

func (reader DeviceTLSFileReader) ReadMaterials(certificatePath, privateKeyPath, advertisedHostname string) (*DeviceTLSMaterials, error) {
	certificate, err := reader.ReadOwned(certificatePath)
	if err != nil {
		return nil, err
	}
	key, err := reader.ReadOwned(privateKeyPath)
	if err != nil {
		return nil, err
	}
	if err := ValidateDeviceTLSMaterials(certificate, key, advertisedHostname); err != nil {
		return nil, err
	}
	return &DeviceTLSMaterials{Certificate: certificate, Key: key}, nil
}
