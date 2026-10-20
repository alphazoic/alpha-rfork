package mega

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/fserrors"
	"github.com/stretchr/testify/require"
	megaclient "github.com/t3rm1n4l/go-mega"
)

type resumeFixture struct {
	fixtureUpload
	known       []bool
	plain       []byte
	mu          sync.Mutex
	phases      []megaclient.UploadCheckpointPhase
	activeSaves atomic.Int32
	committing  atomic.Bool
}

func (u *resumeFixture) AcknowledgedChunks() []bool { return append([]bool(nil), u.known...) }
func (u *resumeFixture) VerifyAcknowledgedChunk(id int, b []byte) error {
	if !bytes.Equal(b, u.plain[id*u.size:(id+1)*u.size]) {
		return megaclient.ErrUploadCheckpointSource
	}
	return nil
}
func (u *resumeFixture) UploadRangeContext(ctx context.Context, first, count int, b []byte) error {
	for id := first; id < first+count; id++ {
		if err := u.fixtureUpload.UploadChunkContext(ctx, id, b[(id-first)*u.size:(id-first+1)*u.size]); err != nil {
			return err
		}
	}
	return nil
}
func (u *resumeFixture) SealCheckpoint(_ megaclient.UploadCheckpointBinding, phase megaclient.UploadCheckpointPhase, _ string) ([]byte, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.phases = append(u.phases, phase)
	return []byte(phase), nil
}

type resumeStoreFixture struct{ save func([]byte) error }

func (s resumeStoreFixture) Save(b []byte) error { return s.save(b) }

func resumeSourceFixture(t *testing.T, b []byte) *resumeSource {
	t.Helper()
	name := filepath.Join(t.TempDir(), "source")
	require.NoError(t, os.WriteFile(name, b, 0600))
	s, err := openResumeSource(context.Background(), name)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestUploadResumeSkipsOnlyAuthenticatedRangesAndCommitsAfterWriter(t *testing.T) {
	plain := bytes.Repeat([]byte("abcdefgh"), 12)
	u := &resumeFixture{fixtureUpload: fixtureUpload{chunks: 12, size: 8}, known: []bool{true, false, true, false, true, false, false, true, false, true, false, true}, plain: plain}
	source := resumeSourceFixture(t, plain)
	var accounted atomic.Int64
	var savesMu sync.Mutex
	var saved []string
	store := resumeStoreFixture{save: func(b []byte) error {
		u.activeSaves.Add(1)
		defer u.activeSaves.Add(-1)
		time.Sleep(time.Millisecond)
		savesMu.Lock()
		saved = append(saved, string(b))
		savesMu.Unlock()
		return nil
	}}
	commit := func(context.Context) (string, error) {
		u.committing.Store(true)
		if u.active.Load() != 0 || u.activeSaves.Load() != 0 {
			return "", errors.New("commit raced worker or writer")
		}
		savesMu.Lock()
		defer savesMu.Unlock()
		if saved[len(saved)-1] != string(megaclient.CheckpointCommitIntent) {
			return "", errors.New("intent not durable before commit")
		}
		u.finished.Add(1)
		return "confirmed-node", nil
	}
	node, err := runResumeUpload(context.Background(), source, u, megaclient.UploadCheckpointBinding{SHA256: sha256.Sum256(plain), Size: int64(len(plain))}, store,
		resumeUploadOptions{workers: 4, requestSize: 1 << 20, interval: time.Millisecond},
		func(_ context.Context, n int) error { accounted.Add(int64(n)); return nil }, commit)
	require.NoError(t, err)
	require.Equal(t, "confirmed-node", node)
	require.Equal(t, int64(6*8), accounted.Load())
	require.Len(t, u.seen, 6)
	for id := range u.seen {
		require.False(t, u.known[id])
	}
	require.Equal(t, int32(1), u.finished.Load())
	// The committed tombstone is the only save permitted after the API call.
	require.Equal(t, string(megaclient.CheckpointCommitted), saved[len(saved)-1])
	for _, phase := range saved[len(saved)-2:] {
		require.NotEqual(t, string(megaclient.CheckpointUploading), phase)
	}
}

func TestUploadResumeStorageFailureNeverCommits(t *testing.T) {
	for _, at := range []string{"initial", "background", "intent", "committed"} {
		t.Run(at, func(t *testing.T) {
			plain := bytes.Repeat([]byte("abcdefgh"), 12)
			u := &resumeFixture{fixtureUpload: fixtureUpload{chunks: 12, size: 8}, known: make([]bool, 12), plain: plain}
			var saves atomic.Int32
			fault := errors.New("disk fault")
			store := resumeStoreFixture{save: func(b []byte) error {
				n := saves.Add(1)
				if at == "initial" && n == 1 || at == "background" && string(b) == "uploading" && n > 1 || string(b) == at || at == "intent" && string(b) == "commit-intent" {
					return fault
				}
				return nil
			}}
			_, err := runResumeUpload(context.Background(), resumeSourceFixture(t, plain), u, megaclient.UploadCheckpointBinding{SHA256: sha256.Sum256(plain), Size: int64(len(plain))}, store,
				resumeUploadOptions{workers: 2, interval: 0}, func(context.Context, int) error { return nil }, func(context.Context) (string, error) { u.finished.Add(1); return "node", nil })
			require.Error(t, err)
			if at == "committed" {
				require.Equal(t, int32(1), u.finished.Load())
			} else {
				require.Zero(t, u.finished.Load())
			}
			require.Zero(t, u.active.Load())
			if at == "initial" {
				require.Empty(t, u.seen)
			}
		})
	}
}

func TestUploadResumeChangedSourceNeverCommits(t *testing.T) {
	for _, known := range []bool{false, true} {
		t.Run(map[bool]string{false: "stream-hash", true: "saved-MAC"}[known], func(t *testing.T) {
			plain := []byte("abcdefgh")
			source := resumeSourceFixture(t, plain)
			u := &resumeFixture{fixtureUpload: fixtureUpload{chunks: 1, size: 8}, known: []bool{known}, plain: bytes.Repeat([]byte("z"), 8)}
			if !known {
				require.NoError(t, os.WriteFile(source.Name(), []byte("changed!"), 0600))
				// Even preserving metadata cannot authorize changed bytes.
				require.NoError(t, os.Chtimes(source.Name(), source.info.ModTime(), source.info.ModTime()))
			}
			_, err := runResumeUpload(context.Background(), source, u, megaclient.UploadCheckpointBinding{SHA256: sha256.Sum256(plain), Size: 8}, resumeStoreFixture{save: func([]byte) error { return nil }},
				resumeUploadOptions{workers: 1}, func(context.Context, int) error { return nil }, func(context.Context) (string, error) { u.finished.Add(1); return "node", nil })
			require.Error(t, err)
			require.Zero(t, u.finished.Load())
			require.Empty(t, u.seen, "changed bytes reached upload workers")
			for _, phase := range u.phases {
				require.Equal(t, megaclient.CheckpointUploading, phase)
			}
		})
	}
}

func TestUploadResumeCancellationJoinsAndSavesWithoutIntent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	plain := bytes.Repeat([]byte("abcdefgh"), 12)
	u := &resumeFixture{fixtureUpload: fixtureUpload{chunks: 12, size: 8}, known: make([]bool, 12), plain: plain}
	u.upload = func(ctx context.Context, _ int, _ []byte) error { cancel(); <-ctx.Done(); return ctx.Err() }
	_, err := runResumeUpload(ctx, resumeSourceFixture(t, plain), u, megaclient.UploadCheckpointBinding{SHA256: sha256.Sum256(plain), Size: int64(len(plain))}, resumeStoreFixture{save: func([]byte) error { return nil }},
		resumeUploadOptions{workers: 4, interval: time.Hour}, func(context.Context, int) error { return nil }, func(context.Context) (string, error) { u.finished.Add(1); return "node", nil })
	require.ErrorIs(t, err, context.Canceled)
	require.Zero(t, u.active.Load())
	require.Zero(t, u.finished.Load())
	for _, phase := range u.phases {
		require.Equal(t, megaclient.CheckpointUploading, phase)
	}
}

func TestUploadResumeOptionsAndSourceValidation(t *testing.T) {
	_, err := parseResumeCommand([]string{"relative"}, map[string]string{"name": "file", "checkpoint": "/tmp/state"})
	require.Error(t, err)
	for _, opts := range []map[string]string{
		{"name": "../escape", "checkpoint": "/tmp/state"},
		{"name": "file", "checkpoint": "relative"},
		{"name": "file", "checkpoint": "/tmp/state", "checkpoint-interval": "-1s"},
		{"name": "file", "checkpoint": "/tmp/state", "unknown": "true"},
	} {
		_, err := parseResumeCommand([]string{filepath.Join(t.TempDir(), "file")}, opts)
		require.Error(t, err)
	}
	_, err = openResumeSource(context.Background(), t.TempDir())
	require.Error(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = openResumeSource(ctx, filepath.Join(t.TempDir(), "absent"))
	require.ErrorIs(t, err, context.Canceled)
}

func TestUploadResumeCommandDryRunAndUnknownCommand(t *testing.T) {
	f := &Fs{}
	ctx, ci := fs.AddConfig(context.Background())
	ci.DryRun = true
	state := filepath.Join(t.TempDir(), "state")
	out, err := f.Command(ctx, "upload-resume", []string{filepath.Join(t.TempDir(), "absent")}, map[string]string{"name": "file", "checkpoint": state})
	require.NoError(t, err)
	require.NotNil(t, out)
	_, err = os.Stat(state)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = f.Command(ctx, "unknown", nil, nil)
	require.ErrorIs(t, err, fs.ErrorCommandNotFound)
}

func TestUploadResumeWriterFailureCancelsActiveWorkers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	plain := []byte("abcdefghijklmnop")
	u := &resumeFixture{fixtureUpload: fixtureUpload{chunks: 2, size: 8}, known: make([]bool, 2), plain: plain}
	entered := make(chan struct{})
	u.upload = func(ctx context.Context, id int, _ []byte) error {
		if id == 0 {
			<-entered
			return nil
		}
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}
	fault := errors.New("checkpoint fault")
	var saves atomic.Int32
	store := resumeStoreFixture{save: func([]byte) error {
		if saves.Add(1) > 1 {
			return fault
		}
		return nil
	}}
	_, err := runResumeUpload(ctx, resumeSourceFixture(t, plain), u, megaclient.UploadCheckpointBinding{SHA256: sha256.Sum256(plain), Size: 16}, store,
		resumeUploadOptions{workers: 2}, func(context.Context, int) error { return nil }, func(context.Context) (string, error) { u.finished.Add(1); return "node", nil })
	require.ErrorIs(t, err, fault)
	require.Zero(t, u.active.Load())
	require.Zero(t, u.finished.Load())
}

func TestUploadResumeCommitFailureRetainsIntentWithoutReplay(t *testing.T) {
	for _, cancelAfterIntent := range []bool{false, true} {
		t.Run(map[bool]string{false: "lost-reply", true: "cancel-after-intent"}[cancelAfterIntent], func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			plain := []byte("abcdefgh")
			u := &resumeFixture{fixtureUpload: fixtureUpload{chunks: 1, size: 8}, known: []bool{false}, plain: plain}
			var saved string
			store := resumeStoreFixture{save: func(b []byte) error {
				saved = string(b)
				if cancelAfterIntent && saved == "commit-intent" {
					cancel()
				}
				return nil
			}}
			private := errors.New("https://private.invalid/upload-token account-password")
			_, err := runResumeUpload(ctx, resumeSourceFixture(t, plain), u, megaclient.UploadCheckpointBinding{SHA256: sha256.Sum256(plain), Size: 8}, store,
				resumeUploadOptions{workers: 1}, func(context.Context, int) error { return nil }, func(context.Context) (string, error) { u.finished.Add(1); return "", private })
			require.Error(t, err)
			require.Equal(t, "commit-intent", saved)
			require.NotContains(t, err.Error(), "private.invalid")
			require.NotContains(t, err.Error(), "account-password")
			if cancelAfterIntent {
				require.Zero(t, u.finished.Load())
			} else {
				require.Equal(t, int32(1), u.finished.Load())
				require.True(t, fserrors.IsNoRetryError(err))
			}
		})
	}
}

func TestUploadResumeWriterCoalescesAndJoins(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls, active atomic.Int32
	var concurrent atomic.Bool
	w := startResumeCheckpointWriter(0, func() error {
		if active.Add(1) > 1 {
			concurrent.Store(true)
		}
		defer active.Add(-1)
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return nil
	}, func() {})
	w.changed()
	<-entered
	for range 10000 {
		w.changed()
	}
	done := make(chan error, 1)
	go func() { done <- w.finish() }()
	close(release)
	require.NoError(t, <-done)
	require.False(t, concurrent.Load())
	require.LessOrEqual(t, calls.Load(), int32(3))
	require.Zero(t, active.Load())
}
