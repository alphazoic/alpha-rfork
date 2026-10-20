package checkpoint

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func openStore(t *testing.T) (*Store, string) {
	t.Helper()
	if !platformSupported {
		t.Skip("checkpoint storage is unavailable on this platform")
	}
	dir := filepath.Join(t.TempDir(), "private")
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s, dir
}

func TestStoreAtomicSnapshotsAndLostState(t *testing.T) {
	s, dir := openStore(t)
	if _, err := s.Read(); !errors.Is(err, ErrMissing) {
		t.Fatal("new store is not empty")
	}
	for _, blob := range [][]byte{[]byte("first sealed state"), []byte("next sealed state")} {
		if err := s.Save(blob); err != nil {
			t.Fatal(err)
		}
		got, err := s.Read()
		if err != nil || string(got) != string(blob) {
			t.Fatal("snapshot changed")
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "state")); err != nil {
		t.Fatal(err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = again.Close() }()
	if _, err := again.Read(); !errors.Is(err, ErrLost) {
		t.Fatal("lost state was treated as a new upload")
	}
}

func TestStoreWriteFailuresPreserveSafeState(t *testing.T) {
	for _, kind := range []string{"write", "sync", "close", "rename", "directory-sync"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := openStore(t)
			if err := s.Save([]byte("old")); err != nil {
				t.Fatal(err)
			}
			fault := errors.New("injected storage failure")
			saved := s.ops
			switch kind {
			case "write":
				s.ops.write = func(*os.File, []byte) (int, error) { return 0, io.ErrShortWrite }
			case "sync":
				s.ops.sync = func(*os.File) error { return fault }
			case "close":
				s.ops.close = func(f *os.File) error { _ = f.Close(); return fault }
			case "rename":
				s.ops.rename = func(string, string) error { return fault }
			case "directory-sync":
				s.ops.directorySync = func() error { return fault }
			}
			if err := s.Save([]byte("new")); !errors.Is(err, ErrIO) {
				t.Fatal("failed durability barrier reported success")
			}
			s.ops = saved
			got, err := s.Read()
			if err != nil {
				t.Fatal(err)
			}
			want := "old"
			if kind == "directory-sync" {
				want = "new"
			}
			if string(got) != want {
				t.Fatal("failure exposed partial state")
			}
		})
	}
}

func TestStoreRefusesLinksAndOversize(t *testing.T) {
	s, dir := openStore(t)
	if err := s.Save(make([]byte, MaxBytes+1)); !errors.Is(err, ErrUnsafe) {
		t.Fatal("unbounded snapshot accepted")
	}
	if err := s.Save([]byte("sealed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, "state"), filepath.Join(dir, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(); !errors.Is(err, ErrUnsafe) {
		t.Fatal("multiply linked checkpoint accepted")
	}
	if err := s.Save([]byte("replacement")); !errors.Is(err, ErrUnsafe) {
		t.Fatal("multiply linked checkpoint replaced")
	}
}

func TestStoreInitializationFailureDoesNotReset(t *testing.T) {
	s, _ := openStore(t)
	operations := s.ops
	s.ops.write = func(*os.File, []byte) (int, error) { return 1, nil }
	if err := s.Save([]byte("sealed")); !errors.Is(err, ErrIO) {
		t.Fatal("short initialization write reported success")
	}
	s.ops = operations
	if _, err := s.Read(); !errors.Is(err, ErrLost) {
		t.Fatal("partial initialization became a fresh upload")
	}
}

func TestStoreRejectsUnsafeDirectoryAndSymlink(t *testing.T) {
	if !platformSupported {
		t.Skip("unsupported platform")
	}
	public := filepath.Join(t.TempDir(), "public")
	if err := os.Mkdir(public, 0755); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(public); !errors.Is(err, ErrUnsafe) {
		if s != nil {
			_ = s.Close()
		}
		t.Fatal("unprotected directory accepted")
	}
	s, dir := openStore(t)
	if err := s.Save([]byte("sealed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "state"), filepath.Join(dir, "elsewhere")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("elsewhere", filepath.Join(dir, "state")); err != nil {
		t.Skip("OS did not permit symlink creation")
	}
	if _, err := s.Read(); !errors.Is(err, ErrUnsafe) {
		t.Fatal("checkpoint symlink followed")
	}
}

func TestStoreProcessDeathReleasesLock(t *testing.T) {
	s, dir := openStore(t)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestStoreProcessLockHelper$")
	cmd.Env = append(os.Environ(), "RFORK_STORE_TEST_DIR="+dir, "RFORK_STORE_TEST_EXPECT=hold")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || ready != "locked\n" {
		t.Fatal("lock holder did not start")
	}
	if other, err := Open(dir); !errors.Is(err, ErrBusy) {
		if other != nil {
			_ = other.Close()
		}
		t.Fatal("live process did not retain ownership")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	recovered, err := Open(dir)
	if err != nil {
		t.Fatal("OS did not release ownership after process death")
	}
	if err := recovered.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestStoreCrossProcessLock(t *testing.T) {
	s, dir := openStore(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := func(busy bool) {
		t.Helper()
		expect := "free"
		if busy {
			expect = "busy"
		}
		cmd := exec.Command(executable, "-test.run=^TestStoreProcessLockHelper$")
		cmd.Env = append(os.Environ(), "RFORK_STORE_TEST_DIR="+dir, "RFORK_STORE_TEST_EXPECT="+expect)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("lock helper: %s", output)
		}
	}
	child(true)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	child(false)
}

func TestStoreProcessLockHelper(t *testing.T) {
	if flag.Lookup("test.run").Value.String() != "^TestStoreProcessLockHelper$" || os.Getenv("RFORK_STORE_TEST_DIR") == "" {
		t.Skip("subprocess helper")
	}
	s, err := Open(os.Getenv("RFORK_STORE_TEST_DIR"))
	if os.Getenv("RFORK_STORE_TEST_EXPECT") == "busy" {
		if !errors.Is(err, ErrBusy) {
			t.Fatal("second process acquired lock")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("RFORK_STORE_TEST_EXPECT") == "hold" {
		if _, err := os.Stdout.WriteString("locked\n"); err != nil {
			t.Fatal(err)
		}
		for {
			time.Sleep(time.Second)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}
