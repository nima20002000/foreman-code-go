package devices_test

import (
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/nima20002000/foreman-code-go/backend/internal/devices"
)

func privateDeviceTLSFile(t *testing.T, material []byte, mode os.FileMode) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "material")
	if err := os.WriteFile(path, material, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDeviceTLSFileAllowsOwnedPrivateRegularMaterial(t *testing.T) {
	cases := []struct {
		name string
		mode os.FileMode
		size int
	}{
		{name: "private read write", mode: 0o600, size: 17},
		{name: "private read only", mode: 0o400, size: 17},
		{name: "owner execute permitted", mode: 0o700, size: 17},
		{name: "setuid bit permitted", mode: 0o600 | os.ModeSetuid, size: 17},
		{name: "setgid bit permitted", mode: 0o600 | os.ModeSetgid, size: 17},
		{name: "sticky bit permitted", mode: 0o600 | os.ModeSticky, size: 17},
		{name: "empty file", mode: 0o600, size: 0},
		{name: "exact initial size limit", mode: 0o600, size: 65536},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			want := bytes.Repeat([]byte{0x61}, test.size)
			path := privateDeviceTLSFile(t, want, test.mode)
			got, err := devices.ReadOwnedDeviceTLSFile(path)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("private regular material read: bytes=%d error=%v", len(got), err)
			}
		})
	}
}

func TestDeviceTLSFileRejectsSharedAndOversizedMaterial(t *testing.T) {
	cases := []struct {
		name string
		mode os.FileMode
		size int
	}{
		{name: "group read", mode: 0o640, size: 1},
		{name: "group write", mode: 0o620, size: 1},
		{name: "group execute", mode: 0o610, size: 1},
		{name: "other read", mode: 0o604, size: 1},
		{name: "other write", mode: 0o602, size: 1},
		{name: "other execute", mode: 0o601, size: 1},
		{name: "initial size above limit", mode: 0o600, size: 65537},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			path := privateDeviceTLSFile(t, bytes.Repeat([]byte{0x61}, test.size), test.mode)
			got, err := devices.ReadOwnedDeviceTLSFile(path)
			if got != nil || !errors.Is(err, devices.ErrDeviceTLSFilePermissions) || err.Error() != "Device TLS files must be owner-only regular files owned by Main’s OS user." {
				t.Fatalf("unsafe material result = %v", err)
			}
		})
	}
}

func TestDeviceTLSFileRejectsSymlinkTraversal(t *testing.T) {
	cases := []struct {
		name string
		path func(*testing.T, string) string
	}{
		{name: "leaf symlink", path: func(t *testing.T, target string) string {
			alias := filepath.Join(filepath.Dir(target), "alias")
			if err := os.Symlink(target, alias); err != nil {
				t.Fatal(err)
			}
			return alias
		}},
		{name: "parent symlink", path: func(t *testing.T, target string) string {
			alias := filepath.Join(t.TempDir(), "alias")
			if err := os.Symlink(filepath.Dir(target), alias); err != nil {
				t.Fatal(err)
			}
			return filepath.Join(alias, filepath.Base(target))
		}},
		{name: "parent symlink before dot dot", path: func(t *testing.T, target string) string {
			root := filepath.Dir(target)
			deeper := filepath.Join(root, "other", "deep")
			if err := os.MkdirAll(deeper, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "other", "material"), []byte("other material"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(deeper, filepath.Join(root, "alias")); err != nil {
				t.Fatal(err)
			}
			// Keep the original traversal; filepath.Join would erase alias/...
			return root + "/alias/../material"
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			target := privateDeviceTLSFile(t, []byte("private material"), 0o600)
			got, err := devices.ReadOwnedDeviceTLSFile(test.path(t, target))
			if got != nil || !errors.Is(err, devices.ErrDeviceTLSFileSymlink) || err.Error() != "Device TLS files must not use symbolic links." {
				t.Fatalf("symlinked material result = %v", err)
			}
		})
	}
}

func TestDeviceTLSFileAcceptsCanonicalRelativeAndHardLinkedMaterial(t *testing.T) {
	for _, name := range []string{"relative", "hard link"} {
		t.Run(name, func(t *testing.T) {
			want := []byte("private fixture")
			path := privateDeviceTLSFile(t, want, 0o600)
			if name == "relative" {
				current, err := os.Getwd()
				if err != nil {
					t.Fatal(err)
				}
				path, err = filepath.Rel(current, path)
				if err != nil {
					t.Fatal(err)
				}
			} else {
				alias := filepath.Join(filepath.Dir(path), "hard-link")
				if err := os.Link(path, alias); err != nil {
					t.Fatal(err)
				}
				path = alias
			}
			got, err := devices.ReadOwnedDeviceTLSFile(path)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("canonical private file rejected: %v", err)
			}
		})
	}
}

func TestDeviceTLSFileRejectsSpecialFilesWithoutBlocking(t *testing.T) {
	t.Run("directory", func(t *testing.T) {
		path, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		got, err := devices.ReadOwnedDeviceTLSFile(path)
		if got != nil || !errors.Is(err, devices.ErrDeviceTLSFilePermissions) {
			t.Fatalf("directory material result = %v", err)
		}
	})
	t.Run("FIFO without a writer", func(t *testing.T) {
		directory, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, "fifo")
		if err := syscall.Mkfifo(path, 0o600); err != nil {
			t.Fatal(err)
		}
		result := make(chan error, 1)
		go func() {
			_, err := devices.ReadOwnedDeviceTLSFile(path)
			result <- err
		}()
		select {
		case err := <-result:
			if !errors.Is(err, devices.ErrDeviceTLSFilePermissions) {
				t.Fatalf("FIFO material result = %v", err)
			}
		case <-time.After(2 * time.Second):
			// Release a broken blocking opener before reporting its behavior.
			writer, err := os.OpenFile(path, os.O_RDWR|syscall.O_NONBLOCK, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Close()
			select {
			case <-result:
			case <-time.After(2 * time.Second):
				t.Fatal("FIFO reader did not finish after fixture release")
			}
			t.Fatal("TLS material open blocked waiting for a FIFO writer")
		}
	})
	t.Run("Unix socket", func(t *testing.T) {
		directory, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, "socket")
		listener, err := net.Listen("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		got, err := devices.ReadOwnedDeviceTLSFile(path)
		if got != nil || err == nil {
			t.Fatal("Unix socket was accepted as TLS material")
		}
	})
}

func TestDeviceTLSFileRejectsMissingMaterial(t *testing.T) {
	got, err := devices.ReadOwnedDeviceTLSFile(filepath.Join(t.TempDir(), "missing"))
	if got != nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing material result = %v", err)
	}
}

type deviceTLSFaultFS struct {
	realPath func(string) (string, error)
	open     func(string) (devices.DeviceTLSFile, error)
}

func (filesystem deviceTLSFaultFS) RealPath(path string) (string, error) {
	if filesystem.realPath != nil {
		return filesystem.realPath(path)
	}
	return (devices.NativeDeviceTLSFileSystem{}).RealPath(path)
}

func (filesystem deviceTLSFaultFS) Open(path string) (devices.DeviceTLSFile, error) {
	if filesystem.open != nil {
		return filesystem.open(path)
	}
	return (devices.NativeDeviceTLSFileSystem{}).Open(path)
}

type deviceTLSFaultFile struct {
	devices.DeviceTLSFile
	stat     func() (os.FileInfo, error)
	read     func([]byte) (int, error)
	closeErr error
	closes   int
}

func (file *deviceTLSFaultFile) Stat() (os.FileInfo, error) {
	if file.stat != nil {
		return file.stat()
	}
	return file.DeviceTLSFile.Stat()
}

func (file *deviceTLSFaultFile) Read(buffer []byte) (int, error) {
	if file.read != nil {
		return file.read(buffer)
	}
	return file.DeviceTLSFile.Read(buffer)
}

func (file *deviceTLSFaultFile) Close() error {
	file.closes++
	if err := file.DeviceTLSFile.Close(); err != nil {
		return err
	}
	return file.closeErr
}

type deviceTLSFileInfo struct {
	os.FileInfo
	mode os.FileMode
	sys  any
}

func (info deviceTLSFileInfo) Mode() os.FileMode { return info.mode }
func (info deviceTLSFileInfo) Sys() any          { return info.sys }

func TestDeviceTLSFileDescriptorFailuresAndClosure(t *testing.T) {
	statFailure := errors.New("fixture stat failure")
	readFailure := errors.New("fixture read failure")
	closeFailure := errors.New("fixture close failure")
	cases := []struct {
		name       string
		statErr    error
		readErr    error
		closeErr   error
		mode       os.FileMode
		wrongUID   bool
		unknownUID bool
		want       error
	}{
		{name: "success closes", mode: 0o600},
		{name: "stat error", mode: 0o600, statErr: statFailure, want: statFailure},
		{name: "read error", mode: 0o600, readErr: readFailure, want: readFailure},
		{name: "nonblocking read error", mode: 0o600, readErr: syscall.EAGAIN, want: syscall.EAGAIN},
		{name: "different owner", mode: 0o600, wrongUID: true, want: devices.ErrDeviceTLSFilePermissions},
		{name: "unknown owner", mode: 0o600, unknownUID: true, want: devices.ErrDeviceTLSFilePermissions},
		{name: "device type", mode: 0o600 | os.ModeDevice, want: devices.ErrDeviceTLSFilePermissions},
		{name: "shared mode", mode: 0o640, want: devices.ErrDeviceTLSFilePermissions},
		{name: "close overrides success", mode: 0o600, closeErr: closeFailure, want: closeFailure},
		{name: "close overrides stat", mode: 0o600, statErr: statFailure, closeErr: closeFailure, want: closeFailure},
		{name: "close overrides policy", mode: 0o640, closeErr: closeFailure, want: closeFailure},
		{name: "close overrides read", mode: 0o600, readErr: readFailure, closeErr: closeFailure, want: closeFailure},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			want := []byte("private disposable material")
			path := privateDeviceTLSFile(t, want, 0o600)
			var opened *deviceTLSFaultFile
			reader := devices.DeviceTLSFileReader{FileSystem: deviceTLSFaultFS{open: func(path string) (devices.DeviceTLSFile, error) {
				native, err := (devices.NativeDeviceTLSFileSystem{}).Open(path)
				if err != nil {
					return nil, err
				}
				t.Cleanup(func() { native.Close() })
				opened = &deviceTLSFaultFile{DeviceTLSFile: native, closeErr: test.closeErr}
				opened.stat = func() (os.FileInfo, error) {
					if test.statErr != nil {
						return nil, test.statErr
					}
					info, err := native.Stat()
					if err != nil {
						return nil, err
					}
					stat := *info.Sys().(*syscall.Stat_t)
					if test.wrongUID {
						stat.Uid++
					}
					var identity any = &stat
					if test.unknownUID {
						identity = nil
					}
					return deviceTLSFileInfo{FileInfo: info, mode: test.mode, sys: identity}, nil
				}
				if test.readErr != nil {
					opened.read = func(buffer []byte) (int, error) {
						return copy(buffer, []byte("partial material")), test.readErr
					}
				}
				return opened, nil
			}}}
			got, err := reader.ReadOwned(path)
			if err != test.want {
				t.Fatalf("read error = %v; want %v", err, test.want)
			}
			if err != nil && got != nil || err == nil && !bytes.Equal(got, want) {
				t.Fatal("read returned partial material or changed successful bytes")
			}
			if opened == nil || opened.closes != 1 {
				t.Fatal("opened descriptor was not closed exactly once")
			}
			if _, err := opened.DeviceTLSFile.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("descriptor remains readable after material result: %v", err)
			}
		})
	}
}

func TestDeviceTLSFilePropagatesPathAndOpenErrors(t *testing.T) {
	for _, stage := range []string{"realpath", "open"} {
		t.Run(stage, func(t *testing.T) {
			path := privateDeviceTLSFile(t, []byte("material"), 0o600)
			failure := errors.New("fixture filesystem failure")
			filesystem := deviceTLSFaultFS{}
			if stage == "realpath" {
				filesystem.realPath = func(string) (string, error) { return "", failure }
				filesystem.open = func(string) (devices.DeviceTLSFile, error) {
					t.Fatal("open ran after a realpath failure")
					return nil, failure
				}
			} else {
				filesystem.open = func(string) (devices.DeviceTLSFile, error) { return nil, failure }
			}
			got, err := (devices.DeviceTLSFileReader{FileSystem: filesystem}).ReadOwned(path)
			if got != nil || err != failure {
				t.Fatalf("filesystem failure changed: %v", err)
			}
		})
	}
}

func TestDeviceTLSFileRejectsFinalSymlinkSwap(t *testing.T) {
	path := privateDeviceTLSFile(t, []byte("approved fixture"), 0o600)
	other := privateDeviceTLSFile(t, []byte("different fixture"), 0o600)
	filesystem := deviceTLSFaultFS{realPath: func(path string) (string, error) {
		canonical, err := (devices.NativeDeviceTLSFileSystem{}).RealPath(path)
		if err != nil {
			return "", err
		}
		if err := os.Remove(path); err != nil {
			return "", err
		}
		if err := os.Symlink(other, path); err != nil {
			return "", err
		}
		return canonical, nil
	}}
	got, err := (devices.DeviceTLSFileReader{FileSystem: filesystem}).ReadOwned(path)
	if got != nil || !errors.Is(err, syscall.ELOOP) {
		t.Fatalf("final symlink race result = %v", err)
	}
}

func TestDeviceTLSFileCollectsShortDescriptorReads(t *testing.T) {
	want := []byte("complete private material")
	path := privateDeviceTLSFile(t, want, 0o600)
	filesystem := deviceTLSFaultFS{open: func(path string) (devices.DeviceTLSFile, error) {
		native, err := (devices.NativeDeviceTLSFileSystem{}).Open(path)
		if err != nil {
			return nil, err
		}
		t.Cleanup(func() { native.Close() })
		return &deviceTLSFaultFile{DeviceTLSFile: native, read: func(buffer []byte) (int, error) {
			if len(buffer) > 3 {
				buffer = buffer[:3]
			}
			return native.Read(buffer)
		}}, nil
	}}
	got, err := (devices.DeviceTLSFileReader{FileSystem: filesystem}).ReadOwned(path)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("short native reads changed material: %v", err)
	}
}

func TestDeviceTLSReadMaterialsClosesCertificateBeforeKey(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	certificatePath := privateDeviceTLSFile(t, fixture.certificate, 0o600)
	keyPath := privateDeviceTLSFile(t, fixture.key, 0o600)
	var opened []devices.DeviceTLSFile
	filesystem := deviceTLSFaultFS{open: func(path string) (devices.DeviceTLSFile, error) {
		for _, prior := range opened {
			if _, err := prior.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
				t.Fatal("another TLS file opened before the preceding descriptor closed")
			}
		}
		file, err := (devices.NativeDeviceTLSFileSystem{}).Open(path)
		if err == nil {
			t.Cleanup(func() { file.Close() })
			opened = append(opened, file)
		}
		return file, err
	}}
	pair, err := (devices.DeviceTLSFileReader{FileSystem: filesystem}).ReadMaterials(certificatePath, keyPath, "main.example.com")
	if err != nil || pair == nil || len(opened) != 2 {
		t.Fatalf("ordered TLS material load = %v", err)
	}
	if !bytes.Equal(pair.Certificate, fixture.certificate) || !bytes.Equal(pair.Key, fixture.key) {
		t.Fatal("material load changed the certificate or private key bytes")
	}
	for _, file := range opened {
		if _, err := file.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
			t.Fatal("TLS material descriptor remained open after validation")
		}
	}
	if pair, err := devices.ReadDeviceTLSMaterials(certificatePath, keyPath, "main.example.com"); err != nil || pair == nil || !bytes.Equal(pair.Certificate, fixture.certificate) || !bytes.Equal(pair.Key, fixture.key) {
		t.Fatalf("native public material load = %v", err)
	}
}

func TestDeviceTLSReadMaterialsPreservesReadAndParseErrorOrder(t *testing.T) {
	fixture := newDeviceTLSFixture(t, nil)
	readFailure := errors.New("fixture material read failed")
	closeFailure := errors.New("fixture material close failed")
	cases := []struct {
		name           string
		failOpen       int
		failRead       int
		failClose      int
		badCertificate bool
		want           error
		wantOpens      int
	}{
		{name: "certificate open failure", failOpen: 1, want: readFailure, wantOpens: 1},
		{name: "certificate read failure", failRead: 1, want: readFailure, wantOpens: 1},
		{name: "certificate close failure", failClose: 1, want: closeFailure, wantOpens: 1},
		{name: "key read before certificate parse", failRead: 2, badCertificate: true, want: readFailure, wantOpens: 2},
		{name: "key close before certificate parse", failClose: 2, badCertificate: true, want: closeFailure, wantOpens: 2},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			certificate := fixture.certificate
			if test.badCertificate {
				certificate = []byte("invalid certificate")
			}
			certificatePath := privateDeviceTLSFile(t, certificate, 0o600)
			keyPath := privateDeviceTLSFile(t, fixture.key, 0o600)
			opens := 0
			var descriptors []devices.DeviceTLSFile
			filesystem := deviceTLSFaultFS{open: func(path string) (devices.DeviceTLSFile, error) {
				opens++
				if test.failOpen == opens {
					return nil, readFailure
				}
				file, err := (devices.NativeDeviceTLSFileSystem{}).Open(path)
				if err != nil {
					return nil, err
				}
				t.Cleanup(func() { file.Close() })
				descriptors = append(descriptors, file)
				wrapped := &deviceTLSFaultFile{DeviceTLSFile: file}
				if test.failRead == opens {
					wrapped.read = func([]byte) (int, error) { return 0, readFailure }
				}
				if test.failClose == opens {
					wrapped.closeErr = closeFailure
				}
				return wrapped, nil
			}}
			pair, err := (devices.DeviceTLSFileReader{FileSystem: filesystem}).ReadMaterials(certificatePath, keyPath, "")
			if pair != nil || err != test.want || opens != test.wantOpens {
				t.Fatalf("material failure/order = %v, opened %d", err, opens)
			}
			for _, file := range descriptors {
				if _, err := file.Read(make([]byte, 1)); !errors.Is(err, os.ErrClosed) {
					t.Fatalf("failed material load left an open descriptor: %v", err)
				}
			}
		})
	}
}
