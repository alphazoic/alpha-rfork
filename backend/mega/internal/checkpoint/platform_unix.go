//go:build linux || darwin

package checkpoint

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

const platformSupported = true

func platformMkdir(dir string) error { return os.Mkdir(dir, 0700) }
func platformPrivate(f *os.File, directory bool) error {
	info, err := f.Stat()
	if err != nil || info.Mode().Perm()&0077 != 0 || info.IsDir() != directory {
		return ErrUnsafe
	}
	if !directory && !info.Mode().IsRegular() {
		return ErrUnsafe
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || !directory && stat.Nlink != 1 {
		return ErrUnsafe
	}
	return nil
}
func platformPin(string, *os.File) (func(), error) { return func() {}, nil }
func platformCreate(s *Store, name string) (*os.File, error) {
	return s.root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
}
func platformRename(s *Store, from, to string) error { return s.root.Rename(from, to) }
func platformDirectorySync(f *os.File) error         { return f.Sync() }
func platformLock(f *os.File) (func() error, error) {
	err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return nil, ErrBusy
	}
	if err != nil {
		return nil, ErrIO
	}
	return func() error { return unix.Flock(int(f.Fd()), unix.LOCK_UN) }, nil
}
