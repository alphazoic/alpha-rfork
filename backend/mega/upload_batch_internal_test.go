package mega

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureBatchRequest struct{ first, count, size int }

type fixtureBatchUpload struct {
	fixtureUpload
	requestsMu   sync.Mutex
	requests     []fixtureBatchRequest
	onRequest    func(context.Context) error
	groupsActive atomic.Int32
}

func (u *fixtureBatchUpload) request(ctx context.Context, first, count int, b []byte) error {
	u.groupsActive.Add(1)
	defer u.groupsActive.Add(-1)
	u.requestsMu.Lock()
	u.requests = append(u.requests, fixtureBatchRequest{first, count, len(b)})
	u.requestsMu.Unlock()
	if u.onRequest != nil {
		if err := u.onRequest(ctx); err != nil {
			return err
		}
	}
	for i := 0; i < count; i++ {
		if err := u.fixtureUpload.UploadChunkContext(ctx, first+i, b[i*u.size:(i+1)*u.size]); err != nil {
			return err
		}
	}
	return nil
}

func (u *fixtureBatchUpload) UploadChunkContext(ctx context.Context, id int, b []byte) error {
	return u.request(ctx, id, 1, b)
}

func (u *fixtureBatchUpload) UploadRangeContext(ctx context.Context, first, count int, b []byte) error {
	return u.request(ctx, first, count, b)
}

func TestUploadBatchGroupingAndContent(t *testing.T) {
	u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 7, size: 1024 * 1024}}
	input := make([]byte, u.chunks*u.size)
	for i := range input {
		input[i] = byte(i/u.size + 3)
	}
	if _, err := uploadAndFinishSized(context.Background(), bytes.NewReader(input), u, 2, 2*1024*1024); err != nil {
		t.Fatal(err)
	}
	if u.finished.Load() != 1 || len(u.seen) != u.chunks || len(u.requests) != 4 {
		t.Fatalf("wrong batches or completion: %+v", u.requests)
	}
	for id, b := range u.seen {
		if !bytes.Equal(b, input[id*u.size:(id+1)*u.size]) {
			t.Fatalf("native chunk %d corrupted", id)
		}
	}
	for _, r := range u.requests {
		if r.size > 2*1024*1024 || r.count < 1 || r.count > 2 {
			t.Fatalf("invalid batch: %+v", r)
		}
	}
}

func TestUploadBatchBoundedReadAheadAndCancellation(t *testing.T) {
	u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 20, size: 1024 * 1024}}
	u.onRequest = func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	in := &countedReader{in: bytes.NewReader(make([]byte, u.chunks*u.size))}
	done := make(chan error, 1)
	go func() { _, err := uploadAndFinishSized(ctx, in, u, 2, 2*1024*1024); done <- err }()
	deadline := time.After(time.Second)
	for in.bytes.Load() < 6*1024*1024 {
		select {
		case err := <-done:
			t.Fatalf("uploader stopped early: %v", err)
		case <-deadline:
			t.Fatal("producer did not fill bounded request jobs")
		case <-time.After(time.Millisecond):
		}
	}
	time.Sleep(10 * time.Millisecond)
	if got := in.bytes.Load(); got > 6*1024*1024 {
		t.Fatalf("read-ahead exceeded workers+1 batches: %d", got)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || u.finished.Load() != 0 {
			t.Fatalf("cancelled batch finalized: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("batch workers failed to join")
	}
}

func TestUploadBatchShortSourceDoesNotFinalize(t *testing.T) {
	u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 4, size: 1024 * 1024}}
	_, err := uploadAndFinishSized(context.Background(), bytes.NewReader(make([]byte, 3*1024*1024)), u, 2, 2*1024*1024)
	if !errors.Is(err, io.ErrUnexpectedEOF) || u.finished.Load() != 0 {
		t.Fatalf("short batched source: %v", err)
	}
}

func TestUploadBatchRejectsInvalidSizeBeforeReading(t *testing.T) {
	for _, size := range []int64{-1, 1024, 65 * 1024 * 1024} {
		u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 1, size: 17}}
		in := &countedReader{in: bytes.NewReader(make([]byte, 17))}
		if _, err := uploadAndFinishSized(context.Background(), in, u, 2, size); err == nil || in.bytes.Load() != 0 || u.finished.Load() != 0 {
			t.Fatalf("invalid request size %d accepted", size)
		}
	}
}

func TestUploadBatchDisabledAndEmptyFiles(t *testing.T) {
	for _, size := range []int{0, 17, 1024 * 1024} {
		u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 1, size: size}}
		if _, err := uploadAndFinishSized(context.Background(), bytes.NewReader(make([]byte, size)), u, 2, 2*1024*1024); err != nil || u.finished.Load() != 1 || len(u.seen) != 1 {
			t.Fatalf("boundary size %d: %v", size, err)
		}
	}
	u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 7, size: 1024 * 1024}}
	if _, err := uploadAndFinishSized(context.Background(), bytes.NewReader(make([]byte, 7*1024*1024)), u, 2, 0); err != nil {
		t.Fatal(err)
	}
	if len(u.requests) != 7 {
		t.Fatal("disabled batching grouped requests")
	}
	for _, r := range u.requests {
		if r.count != 1 {
			t.Fatal("disabled batching changed native requests")
		}
	}
}

func TestUploadBatchFailureCancelsPeersAndJoins(t *testing.T) {
	u := &fixtureBatchUpload{fixtureUpload: fixtureUpload{chunks: 4, size: 1024 * 1024}}
	failed := errors.New("batch rejected")
	entered := make(chan struct{})
	var calls atomic.Int32
	u.onRequest = func(ctx context.Context) error {
		if calls.Add(1) == 1 {
			<-entered
			return failed
		}
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}
	_, err := uploadAndFinishSized(context.Background(), bytes.NewReader(make([]byte, 4*1024*1024)), u, 2, 2*1024*1024)
	if !errors.Is(err, failed) || u.groupsActive.Load() != 0 || u.finished.Load() != 0 {
		t.Fatalf("batch failure leaked work or finalized: %v", err)
	}
}

func TestUploadBatchUnsupportedSessionDoesNotRead(t *testing.T) {
	u := &fixtureUpload{chunks: 1, size: 17}
	in := &countedReader{in: bytes.NewReader(make([]byte, 17))}
	if _, err := uploadAndFinishSized(context.Background(), in, u, 2, 2*1024*1024); err == nil || in.bytes.Load() != 0 {
		t.Fatal("unsupported batch session consumed source")
	}
}

type fixtureVariableUpload struct {
	fixtureUpload
	layout []int
}

func (u *fixtureVariableUpload) Chunks() int { return len(u.layout) }
func (u *fixtureVariableUpload) ChunkLocation(id int) (int64, int, error) {
	if id < 0 || id >= len(u.layout) {
		return 0, 0, errors.New("invalid fixture chunk")
	}
	var position int64
	for _, size := range u.layout[:id] {
		position += int64(size)
	}
	return position, u.layout[id], nil
}

func TestUploadBatchPlannerPreservesVaryingNativeBoundaries(t *testing.T) {
	u := &fixtureVariableUpload{layout: []int{128 * 1024, 256 * 1024, 384 * 1024, 512 * 1024, 640 * 1024, 768 * 1024, 896 * 1024, 1024 * 1024, 1024 * 1024, 31}}
	for _, tc := range []struct {
		first       int
		limit       int64
		count, size int
	}{{0, 2 * 1024 * 1024, 5, 1920 * 1024}, {5, 2 * 1024 * 1024, 2, 1664 * 1024}, {7, 2 * 1024 * 1024, 2, 2048 * 1024}, {9, 2 * 1024 * 1024, 1, 31}, {0, 0, 1, 128 * 1024}} {
		count, size, err := planUploadRange(u, tc.first, tc.limit)
		if err != nil || count != tc.count || size != tc.size {
			t.Fatalf("layout first %d: count=%d size=%d error=%v", tc.first, count, size, err)
		}
	}
}
