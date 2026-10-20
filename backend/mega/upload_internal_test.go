package mega

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/fserrors"
	"github.com/rclone/rclone/lib/pacer"
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

func TestUploadDiagnosticReaderCountsShortSource(t *testing.T) {
	report := &uploadReport{SchemaVersion: 1}
	r := uploadDiagnosticReader{Reader: bytes.NewReader([]byte{1, 2, 3}), report: report}
	if n, err := io.ReadFull(r, make([]byte, 7)); n != 3 || !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("read: %d %v", n, err)
	}
	if report.SourceBytes != 3 || report.SourceRead.Count < 1 || report.SourceRead.Seconds < 0 || report.Committed {
		t.Fatalf("incorrect source diagnostics: %+v", report)
	}
	if _, err := json.Marshal(report); err != nil {
		t.Fatal(err)
	}
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

func TestUploadDataPacingSpacingAndCancellation(t *testing.T) {
	p := newUploadPacer(15 * time.Millisecond)
	if err := p.wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := p.wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 14*time.Millisecond {
		t.Fatal("request started before configured interval")
	}
	p = newUploadPacer(time.Hour)
	if err := p.wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- p.wait(ctx) }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("pacing wait ignored cancellation")
	}
	// Cancelling one backend does not block a separate backend's unpaced path.
	if err := newUploadPacer(0).wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestUploadDataPacingCancelledWaitDoesNotReserveSlot(t *testing.T) {
	p := newUploadPacer(time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := p.wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := p.wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestUploadConnectionLimitIncludesMetadataAndCancels(t *testing.T) {
	f := &Fs{dataPacer: newUploadPacer(0), requestSlots: make(chan struct{}, 1),
		pacer: fs.NewPacer(context.Background(), pacer.NewDefault(pacer.MinSleep(0)))}
	release, err := f.startDataRequest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if release != nil {
			release()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	err = f.call(ctx, func() (bool, error) { t.Error("metadata bypassed connection limit"); return false, nil })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("admission wait: %v", err)
	}
	release()
	release = nil
	called := false
	if err := f.call(context.Background(), func() (bool, error) { called = true; return false, nil }); err != nil || !called || len(f.requestSlots) != 0 {
		t.Fatalf("admission leaked after cancellation: %v", err)
	}
}

func TestUploadConnectionLimitAcrossFiles(t *testing.T) {
	f := &Fs{dataPacer: newUploadPacer(0), requestSlots: make(chan struct{}, 2)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{}, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			release, err := f.startDataRequest(ctx)
			if err != nil {
				return
			}
			defer release()
			entered <- struct{}{}
			<-ctx.Done()
		})
	}
	for range 2 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("upload workers did not acquire slots")
		}
	}
	if len(f.requestSlots) != 2 {
		t.Fatal("unexpected connection admission count")
	}
	cancel()
	workers.Wait()
	if len(f.requestSlots) != 0 {
		t.Fatal("connection slots retained after workers stopped")
	}
}

func TestUploadInvalidOptionsRejectBeforeLogin(t *testing.T) {
	for _, option := range []configmap.Simple{
		{"upload_concurrency": "8", "upload_retries": "-2"},
		{"upload_concurrency": "8", "upload_retries": "-1", "upload_pacing": "-1ms"},
		{"upload_concurrency": "8", "upload_retries": "-1", "upload_request_size": "65Mi"},
	} {
		want := "mega upload retries"
		if option["upload_pacing"] != "" {
			want = "mega upload pacing"
		}
		if option["upload_request_size"] != "" {
			want = "mega upload request size"
		}
		if _, err := NewFs(context.Background(), "invalid", "", option); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("invalid option not rejected before login: %v", err)
		}
	}
}
