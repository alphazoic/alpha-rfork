package mega

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/fserrors"
	megaclient "github.com/t3rm1n4l/go-mega"
)

type fixtureUpload struct {
	chunks    int
	size      int
	active    atomic.Int32
	peak      atomic.Int32
	finished  atomic.Int32
	mu        sync.Mutex
	seen      map[int][]byte
	upload    func(context.Context, int, []byte) error
	finishErr error
}

func (u *fixtureUpload) Chunks() int { return u.chunks }
func (u *fixtureUpload) ChunkLocation(id int) (int64, int, error) {
	return int64(id * u.size), u.size, nil
}
func (u *fixtureUpload) UploadChunkContext(ctx context.Context, id int, b []byte) error {
	n := u.active.Add(1)
	defer u.active.Add(-1)
	for old := u.peak.Load(); n > old && !u.peak.CompareAndSwap(old, n); old = u.peak.Load() {
	}
	if u.upload != nil {
		if err := u.upload(ctx, id, b); err != nil {
			return err
		}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.seen == nil {
		u.seen = map[int][]byte{}
	}
	u.seen[id] = bytes.Clone(b)
	return nil
}
func (u *fixtureUpload) FinishContext(context.Context) (*megaclient.Node, error) {
	u.finished.Add(1)
	if u.active.Load() != 0 {
		return nil, errors.New("finalized while workers active")
	}
	return nil, u.finishErr
}

func TestUploadParallelBoundAndContent(t *testing.T) {
	for _, workers := range []int{1, 2, 4, 8} {
		t.Run(strconv.Itoa(workers), func(t *testing.T) {
			u := &fixtureUpload{chunks: 24, size: 17}
			u.upload = func(ctx context.Context, id int, b []byte) error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Duration(1+id%3) * time.Millisecond):
					return nil
				}
			}
			input := make([]byte, u.chunks*u.size)
			for i := range input {
				input[i] = byte(i)
			}
			_, err := uploadAndFinish(context.Background(), bytes.NewReader(input), u, workers)
			if err != nil {
				t.Fatal(err)
			}
			if u.peak.Load() > int32(workers) || u.peak.Load() != int32(workers) {
				t.Fatalf("peak=%d workers=%d", u.peak.Load(), workers)
			}
			if u.finished.Load() != 1 || len(u.seen) != u.chunks {
				t.Fatalf("finish=%d chunks=%d", u.finished.Load(), len(u.seen))
			}
			for id, b := range u.seen {
				if !bytes.Equal(b, input[id*u.size:(id+1)*u.size]) {
					t.Fatalf("chunk %d corrupted/reused", id)
				}
			}
		})
	}
}

type countedReader struct {
	in    io.Reader
	bytes atomic.Int64
}

func (r *countedReader) Read(b []byte) (int, error) {
	n, err := r.in.Read(b)
	r.bytes.Add(int64(n))
	return n, err
}

func TestUploadProducerHasBoundedReadAhead(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	u := &fixtureUpload{chunks: 100, size: 1024}
	u.upload = func(ctx context.Context, _ int, _ []byte) error { <-ctx.Done(); return ctx.Err() }
	in := &countedReader{in: bytes.NewReader(make([]byte, 100*1024))}
	done := make(chan error, 1)
	go func() { _, err := uploadAndFinish(ctx, in, u, 4); done <- err }()
	deadline := time.After(time.Second)
	for in.bytes.Load() < 5*1024 {
		select {
		case <-deadline:
			t.Fatal("producer did not fill bounded work")
		case <-time.After(time.Millisecond):
		}
	}
	time.Sleep(10 * time.Millisecond)
	if n := in.bytes.Load(); n > 5*1024 {
		t.Fatalf("read ahead %d bytes for four blocked workers", n)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("unexpected stop: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("bounded producer did not stop")
	}
	if u.active.Load() != 0 || u.finished.Load() != 0 {
		t.Fatal("work remained after cancellation")
	}
}

func TestUploadCancellationBeforeCommit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	u := &fixtureUpload{chunks: 1, size: 8}
	u.upload = func(context.Context, int, []byte) error { cancel(); return nil }
	_, err := uploadAndFinish(ctx, bytes.NewReader(make([]byte, 8)), u, 1)
	if !errors.Is(err, context.Canceled) || u.finished.Load() != 0 {
		t.Fatalf("commit after cancellation: %v", err)
	}
}

func TestUploadFailureCancelsPeersAndNeverFinalizes(t *testing.T) {
	failed := errors.New("chunk rejected")
	u := &fixtureUpload{chunks: 50, size: 8}
	entered := make(chan struct{})
	var once sync.Once
	u.upload = func(ctx context.Context, id int, _ []byte) error {
		if id == 0 {
			<-entered
			return failed
		}
		once.Do(func() { close(entered) })
		<-ctx.Done()
		return ctx.Err()
	}
	_, err := uploadAndFinish(context.Background(), bytes.NewReader(make([]byte, 400)), u, 4)
	if !errors.Is(err, failed) || u.active.Load() != 0 || u.finished.Load() != 0 {
		t.Fatalf("error=%v active=%d finish=%d", err, u.active.Load(), u.finished.Load())
	}
}

func TestUploadCancelWaitsForWorkers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	u := &fixtureUpload{chunks: 50, size: 8}
	entered := make(chan struct{})
	var once sync.Once
	u.upload = func(ctx context.Context, _ int, _ []byte) error {
		once.Do(func() { close(entered) })
		<-ctx.Done()
		return ctx.Err()
	}
	done := make(chan error, 1)
	go func() { _, err := uploadAndFinish(ctx, bytes.NewReader(make([]byte, 400)), u, 4); done <- err }()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || u.active.Load() != 0 || u.finished.Load() != 0 {
			t.Fatalf("error=%v active=%d finish=%d", err, u.active.Load(), u.finished.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("cancel hung")
	}
}

func TestUploadShortReadAndEmptyFile(t *testing.T) {
	u := &fixtureUpload{chunks: 3, size: 7}
	_, err := uploadAndFinish(context.Background(), bytes.NewReader(make([]byte, 20)), u, 2)
	if !errors.Is(err, io.ErrUnexpectedEOF) || u.finished.Load() != 0 || u.active.Load() != 0 {
		t.Fatalf("short source: %v", err)
	}
	u = &fixtureUpload{chunks: 1, size: 0}
	_, err = uploadAndFinish(context.Background(), bytes.NewReader(nil), u, 4)
	if err != nil || u.finished.Load() != 1 || len(u.seen) != 1 {
		t.Fatalf("empty file: %v", err)
	}
}

func TestUploadCommitFailureIsNotReplayed(t *testing.T) {
	u := &fixtureUpload{chunks: 1, size: 1, finishErr: io.ErrUnexpectedEOF}
	_, err := uploadAndFinish(context.Background(), bytes.NewReader([]byte{1}), u, 2)
	if err == nil || !fserrors.IsNoRetryError(err) || u.finished.Load() != 1 {
		t.Fatalf("error=%v finish=%d", err, u.finished.Load())
	}
}

func TestUploadInvalidConcurrency(t *testing.T) {
	for _, workers := range []int{0, -1, 33} {
		u := &fixtureUpload{chunks: 1, size: 0}
		_, err := uploadAndFinish(context.Background(), bytes.NewReader(nil), u, workers)
		if err == nil || u.finished.Load() != 0 {
			t.Fatalf("workers=%d error=%v", workers, err)
		}
	}
}
