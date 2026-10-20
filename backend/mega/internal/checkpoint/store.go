// Package checkpoint provides private, exclusively owned local checkpoint storage.
// It stores opaque encrypted envelopes; upload binding and phase policy belong to
// the caller. All writers must be joined before saving final commit intent.
package checkpoint

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// MaxBytes bounds the stored encrypted envelope.
const MaxBytes = 64 << 20

const marker = "rfork checkpoint storage v1\n"

var (
	// ErrUnsupported means this platform/filesystem cannot provide the store contract.
	ErrUnsupported = errors.New("MEGA checkpoint storage requires Linux, macOS or a local NTFS Windows volume")
	// ErrBusy means another process owns the checkpoint directory.
	ErrBusy = errors.New("MEGA checkpoint is owned by another process")
	// ErrUnsafe means paths, ownership, permissions or sizes are unsafe.
	ErrUnsafe = errors.New("unsafe MEGA checkpoint storage")
	// ErrMissing means a never-initialized store has no state yet.
	ErrMissing = errors.New("MEGA checkpoint has not been initialized")
	// ErrLost means previously initialized state is missing or inconsistent.
	ErrLost = errors.New("MEGA checkpoint state was lost; explicit inspection is required")
	// ErrIO means a storage operation or durability barrier failed.
	ErrIO = errors.New("MEGA checkpoint storage operation failed")
)

type storeOps struct {
	write         func(*os.File, []byte) (int, error)
	sync          func(*os.File) error
	close         func(*os.File) error
	rename        func(string, string) error
	directorySync func() error
}

// Store anchors file operations to a verified private directory and holds an OS
// lock until Close or process exit. The stable lock file is never unlinked.
type Store struct {
	mu        sync.Mutex
	root      *os.Root
	directory *os.File
	path      string
	lock      *os.File
	unlock    func() error
	unpin     func()
	closed    bool
	ops       storeOps
}

// Open creates a private directory or verifies an existing one, then acquires
// its lock without waiting. The parent directory must already exist. Paths must
// be absolute. No account material is written before permissions are verified.
func Open(dir string) (*Store, error) {
	if !platformSupported {
		return nil, ErrUnsupported
	}
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
		return nil, ErrUnsafe
	}
	if err := platformMkdir(dir); err != nil && !errors.Is(err, os.ErrExist) {
		if errors.Is(err, ErrUnsupported) {
			return nil, err
		}
		return nil, ErrIO
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrUnsafe
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, ErrUnsafe
	}
	directory, err := root.Open(".")
	if err != nil {
		_ = root.Close()
		return nil, ErrUnsafe
	}
	if platformPrivate(directory, true) != nil {
		_ = directory.Close()
		_ = root.Close()
		return nil, ErrUnsafe
	}
	unpin, err := platformPin(dir, directory)
	if err != nil {
		_ = directory.Close()
		_ = root.Close()
		return nil, ErrUnsafe
	}
	s := &Store{root: root, directory: directory, path: dir, unpin: unpin}
	failed := true
	defer func() {
		if failed {
			_ = s.Close()
		}
	}()
	lock, err := s.openPrivate("lock", false)
	if errors.Is(err, ErrMissing) {
		lock, err = s.newPrivate("lock")
		if errors.Is(err, os.ErrExist) {
			lock, err = s.openPrivate("lock", false)
		}
	}
	if err != nil {
		return nil, ErrUnsafe
	}
	s.lock = lock
	s.unlock, err = platformLock(lock)
	if err != nil {
		return nil, err
	}
	s.ops = storeOps{write: func(f *os.File, b []byte) (int, error) { return f.Write(b) },
		sync: platformFileSync, close: func(f *os.File) error { return f.Close() },
		rename:        func(a, b string) error { return platformRename(s, a, b) },
		directorySync: func() error { return platformDirectorySync(s.directory) }}
	failed = false
	return s, nil
}

func (s *Store) newPrivate(name string) (*os.File, error) {
	f, err := platformCreate(s, name)
	if err != nil {
		return nil, err
	}
	if platformPrivate(f, false) != nil {
		_ = f.Close()
		return nil, ErrUnsafe
	}
	return f, nil
}

func (s *Store) openPrivate(name string, readOnly bool) (*os.File, error) {
	info, err := s.root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrMissing
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrUnsafe
	}
	flag := os.O_RDWR
	if readOnly {
		flag = os.O_RDONLY
	}
	f, err := s.root.OpenFile(name, flag, 0600)
	if err != nil {
		return nil, ErrUnsafe
	}
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) || platformPrivate(f, false) != nil {
		_ = f.Close()
		return nil, ErrUnsafe
	}
	return f, nil
}

func (s *Store) readFile(name string, limit int64) ([]byte, error) {
	f, err := s.openPrivate(name, true)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || info.Size() > limit {
		return nil, ErrUnsafe
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, ErrIO
	}
	if int64(len(data)) > limit {
		return nil, ErrUnsafe
	}
	return data, nil
}

func (s *Store) read() ([]byte, error) {
	init, err := s.readFile("initialized", 128)
	if err != nil && !errors.Is(err, ErrMissing) {
		return nil, err
	}
	data, stateErr := s.readFile("state", MaxBytes)
	if errors.Is(err, ErrMissing) {
		if errors.Is(stateErr, ErrMissing) {
			return nil, ErrMissing
		}
		return nil, ErrLost
	}
	if string(init) != marker || errors.Is(stateErr, ErrMissing) {
		return nil, ErrLost
	}
	return data, stateErr
}

// Read returns a complete opaque envelope. Missing initialized state is never
// treated as a new upload, preventing silent retries after state loss.
func (s *Store) Read() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrIO
	}
	return s.read()
}

func (s *Store) initialize() error {
	_, err := s.readFile("initialized", 128)
	if err == nil {
		return nil
	}
	if !errors.Is(err, ErrMissing) {
		return err
	}
	f, err := s.newPrivate("initialized")
	if err != nil {
		return ErrIO
	}
	n, writeErr := s.ops.write(f, []byte(marker))
	syncErr := s.ops.sync(f)
	closeErr := s.ops.close(f)
	if writeErr != nil || n != len(marker) || syncErr != nil || closeErr != nil {
		return ErrIO
	}
	if s.ops.directorySync() != nil {
		return ErrIO
	}
	return nil
}

// Save serializes writes, flushes a private temporary file, replaces the state
// atomically and completes the platform durability barrier. Any error stops the
// caller before commit; a late error can leave the complete new state on disk.
func (s *Store) Save(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrIO
	}
	if len(data) == 0 || len(data) > MaxBytes {
		return ErrUnsafe
	}
	if _, err := s.read(); err != nil && !errors.Is(err, ErrMissing) {
		return err
	}
	if err := s.initialize(); err != nil {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ErrIO
	}
	name := "pending-" + hex.EncodeToString(random[:])
	f, err := s.newPrivate(name)
	if err != nil {
		return ErrIO
	}
	defer func() { _ = f.Close(); _ = s.root.Remove(name) }()
	n, writeErr := s.ops.write(f, data)
	if writeErr != nil || n != len(data) {
		return ErrIO
	}
	if s.ops.sync(f) != nil {
		return ErrIO
	}
	if s.ops.close(f) != nil {
		return ErrIO
	}
	if s.ops.rename(name, "state") != nil {
		return ErrIO
	}
	if s.ops.directorySync() != nil {
		return ErrIO
	}
	return nil
}

// Close releases ownership and descriptors. It is idempotent and keeps the lock
// inode and final state intact so waiting processes cannot acquire a new inode.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var err error
	if s.unlock != nil {
		err = errors.Join(err, s.unlock())
	}
	if s.lock != nil {
		err = errors.Join(err, s.lock.Close())
	}
	if s.directory != nil {
		err = errors.Join(err, s.directory.Close())
	}
	if s.root != nil {
		err = errors.Join(err, s.root.Close())
	}
	if s.unpin != nil {
		s.unpin()
	}
	if err != nil {
		return ErrIO
	}
	return nil
}
