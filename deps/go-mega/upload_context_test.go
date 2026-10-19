package mega

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func contextUpload(t *testing.T, handler http.HandlerFunc) (*Upload, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	m := New()
	m.SetClient(server.Client())
	m.SetRetries(2)
	m.SetLogger(nil)
	m.k = make([]byte, 16)
	block, _ := aes.NewCipher(make([]byte, 16))
	u := &Upload{m: m, uploadUrl: server.URL, aes_block: block, iv: make([]byte, 16), kiv: make([]byte, 16),
		kbytes: make([]byte, 16), ukey: make([]uint32, 6), mac_enc: cipher.NewCBCEncrypter(block, make([]byte, 16)),
		chunks: getChunkSizes(31), chunk_macs: make([][]byte, 1)}
	return u, server
}

func TestUploadNativeParallelCryptoAndCommit(t *testing.T) {
	const size = 9*1024*1024 + 31
	plain := make([]byte, size)
	for i := range plain {
		plain[i] = byte(i*17 + 3)
	}
	var mu sync.Mutex
	received := map[int64][]byte{}
	var commits atomic.Int32
	var u *Upload
	u, server := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cs" {
			commits.Add(1)
			var msg [1]UploadCompleteMsg
			if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			mu.Lock()
			complete := len(received) == u.Chunks()
			mu.Unlock()
			if !complete {
				t.Error("commit before all chunks arrived")
			}
			response := []UploadCompleteResp{{F: []FSNode{{Hash: "file", Parent: "root", User: "fixture", T: FILE,
				Attr: msg[0].N[0].A, Key: "fixture:" + msg[0].N[0].K, Sz: size}}}}
			if err := json.NewEncoder(w).Encode(response); err != nil {
				t.Error(err)
			}
			return
		}
		offset, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/"), 10, 64)
		if err != nil {
			t.Error(err)
			return
		}
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		// Vary completion order independently of the native chunk index.
		time.Sleep(time.Duration(1+(offset/131072)%5) * time.Millisecond)
		mu.Lock()
		received[offset] = data
		complete := len(received) == len(getChunkSizes(size))
		mu.Unlock()
		if complete {
			_, _ = w.Write([]byte("completion"))
		}
	})
	u.m.SetAPIUrl(server.URL)
	u.chunks = getChunkSizes(size)
	u.chunk_macs = make([][]byte, len(u.chunks))
	u.EnableDiagnostics()
	u.name = "fixture.bin"
	u.parenthash = "root"
	var group sync.WaitGroup
	errs := make(chan error, u.Chunks())
	slots := make(chan struct{}, 4)
	for id := 0; id < u.Chunks(); id++ {
		slots <- struct{}{}
		group.Add(1)
		go func(id int) {
			defer group.Done()
			defer func() { <-slots }()
			pos, n, _ := u.ChunkLocation(id)
			errs <- u.UploadChunkContext(context.Background(), id, bytes.Clone(plain[pos:pos+int64(n)]))
		}(id)
	}
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	node, err := u.FinishContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if node.name != "fixture.bin" || node.size != size || commits.Load() != 1 {
		t.Fatalf("bad node or commit count: %d", commits.Load())
	}
	// Decrypt independently, using the file key recovered from the commit response.
	block, _ := aes.NewCipher(node.meta.key)
	decoded := make([]byte, size)
	for _, chunk := range u.chunks {
		iv := bytes.Clone(node.meta.iv)
		binary.BigEndian.PutUint64(iv[8:], uint64(chunk.position/16))
		cipher.NewCTR(block, iv).XORKeyStream(decoded[chunk.position:chunk.position+int64(chunk.size)], received[chunk.position])
	}
	if !bytes.Equal(decoded, plain) {
		t.Fatal("parallel ciphertext does not round-trip")
	}
	// Independently fold native plaintext CBC MACs in file order.
	aggregate := make([]byte, 16)
	for _, chunk := range u.chunks {
		mac := bytes.Clone(u.iv)
		for pos := chunk.position; pos < chunk.position+int64(chunk.size); pos += 16 {
			b := make([]byte, 16)
			end := min(pos+16, chunk.position+int64(chunk.size))
			copy(b, plain[pos:end])
			for i := range b {
				b[i] ^= mac[i]
			}
			block.Encrypt(mac, b)
		}
		for i := range aggregate {
			aggregate[i] ^= mac[i]
		}
		block.Encrypt(aggregate, aggregate)
	}
	expected := make([]byte, 8)
	binary.BigEndian.PutUint32(expected, binary.BigEndian.Uint32(aggregate[:4])^binary.BigEndian.Uint32(aggregate[4:8]))
	binary.BigEndian.PutUint32(expected[4:], binary.BigEndian.Uint32(aggregate[8:12])^binary.BigEndian.Uint32(aggregate[12:]))
	if !bytes.Equal(node.meta.mac, expected) {
		t.Fatal("commit authentication order is wrong")
	}
	if _, err = u.FinishContext(context.Background()); err == nil || commits.Load() != 1 {
		t.Fatal("commit replayed")
	}
	s := u.Diagnostics()
	if s.Attempts != int64(u.Chunks()) || s.AcknowledgedBytes != size || s.PayloadBytesRead != size || s.ActiveRequests != 0 || s.PeakRequests > 4 {
		t.Fatalf("parallel diagnostics mismatch: %+v", s)
	}
}

func TestUploadLostCommitResponseIsNotRetried(t *testing.T) {
	var calls atomic.Int32
	u, server := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	u.m.SetAPIUrl(server.URL)
	u.chunk_macs[0] = make([]byte, 16)
	u.completion_handle = []byte("completion")
	if _, err := u.FinishContext(context.Background()); err == nil || calls.Load() != 1 {
		t.Fatalf("error=%v calls=%d", err, calls.Load())
	}
}

func TestUploadPerFileHTTPSDoesNotMutateSharedClient(t *testing.T) {
	var requested atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg [1]UploadMsg
		_ = json.NewDecoder(r.Body).Decode(&msg)
		requested.Store(int32(msg[0].SSL))
		_ = json.NewEncoder(w).Encode([]map[string]string{{"p": "http://example.invalid/upload"}})
	}))
	defer server.Close()
	m := New()
	m.SetAPIUrl(server.URL)
	m.SetClient(server.Client())
	m.SetHTTPS(false)
	u, err := m.NewUploadContext(context.Background(), &Node{hash: "root", fs: m.FS}, "test", 31, true)
	if err != nil || !strings.HasPrefix(u.uploadUrl, "https://") || m.https || requested.Load() != 2 {
		t.Fatalf("error=%v transport changed", err)
	}
}

func TestUploadNegativeMEGAResponseIsAnError(t *testing.T) {
	u, _ := contextUpload(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("-17")) })
	if err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31)); err == nil || len(u.chunk_macs[0]) != 0 {
		t.Fatalf("quota response accepted: %v", err)
	}
}

func TestUploadCompletionHandleCanStartWithDash(t *testing.T) {
	const handle = "-url_safe_completion_handle"
	u, _ := contextUpload(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(handle)) })
	if err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31)); err != nil {
		t.Fatalf("valid handle rejected: %v", err)
	}
	if string(u.completion_handle) != handle {
		t.Fatal("completion handle changed")
	}
}

func TestUploadEmptyCommitHasZeroMAC(t *testing.T) {
	var u *Upload
	u, server := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cs" {
			_, _ = w.Write([]byte("completion"))
			return
		}
		var msg [1]UploadCompleteMsg
		_ = json.NewDecoder(r.Body).Decode(&msg)
		encrypted, err := base64urldecode(msg[0].N[0].K)
		if err != nil {
			t.Error(err)
			return
		}
		master, _ := aes.NewCipher(make([]byte, 16))
		key := make([]byte, 32)
		master.Decrypt(key[:16], encrypted[:16])
		master.Decrypt(key[16:], encrypted[16:])
		if !bytes.Equal(key[24:], make([]byte, 8)) {
			t.Error("empty file has a nonzero aggregate MAC")
		}
		_ = json.NewEncoder(w).Encode([]UploadCompleteResp{{F: []FSNode{{Hash: "empty", User: "fixture", T: FILE, Attr: msg[0].N[0].A, Key: "fixture:" + msg[0].N[0].K, Sz: 0}}}})
	})
	u.m.SetAPIUrl(server.URL)
	u.chunks = []chunkSize{{position: 0, size: 0}}
	if err := u.UploadChunkContext(context.Background(), 0, []byte{}); err != nil {
		t.Fatal(err)
	}
	if _, err := u.FinishContext(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestUploadCancellationInterruptsBackoffAndHashcash(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	delay := time.Second
	if err := backOffContext(ctx, &delay); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := solveHashCashChallengeContext(ctx, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 0, time.Minute, 2); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

func TestUploadAPIHTTPFailureNeverReturnsNilError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	m := New()
	m.SetAPIUrl(server.URL)
	m.SetClient(server.Client())
	if _, err := m.apiRequestContext(context.Background(), []byte(`[{"a":"u"}]`), 0); err == nil {
		t.Fatal("HTTP failure became success")
	}
}

func TestUploadCancellationDoesNotCancelAnotherFile(t *testing.T) {
	entered := make(chan struct{})
	u, server := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if strings.HasPrefix(r.URL.Path, "/slow/") {
			close(entered)
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte("completion"))
	})
	u.uploadUrl = server.URL + "/slow"
	other := &Upload{m: u.m, uploadUrl: server.URL + "/fast", aes_block: u.aes_block, iv: bytes.Clone(u.iv), kiv: bytes.Clone(u.kiv), chunks: getChunkSizes(31), chunk_macs: make([][]byte, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- u.UploadChunkContext(ctx, 0, make([]byte, 31)) }()
	<-entered
	cancel()
	if err := other.UploadChunkContext(context.Background(), 0, make([]byte, 31)); err != nil {
		t.Fatalf("other file interrupted: %v", err)
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled file: %v", err)
	}
}

func TestUploadContextRetryKeepsCiphertext(t *testing.T) {
	var mu sync.Mutex
	var bodies [][]byte
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, b)
		n := len(bodies)
		mu.Unlock()
		if n == 1 {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte("completion"))
	})
	plain := bytes.Repeat([]byte{0x5a}, 31)
	if err := u.UploadChunkContext(context.Background(), 0, bytes.Clone(plain)); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 || !bytes.Equal(bodies[0], bodies[1]) || bytes.Equal(bodies[0], plain) {
		t.Fatal("retry did not reuse the same encrypted bytes")
	}
	if len(u.chunk_macs[0]) != 16 {
		t.Fatal("MAC not recorded")
	}
}

func TestUploadContextCancelsHTTPRequest(t *testing.T) {
	entered := make(chan struct{})
	u, _ := contextUpload(t, func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- u.UploadChunkContext(ctx, 0, make([]byte, 31)) }()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request continued after cancellation")
	}
}

func TestUploadContextCanceledBeforeEncryption(t *testing.T) {
	var calls atomic.Int32
	u, _ := contextUpload(t, func(_ http.ResponseWriter, _ *http.Request) { calls.Add(1) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b := bytes.Repeat([]byte{9}, 31)
	original := bytes.Clone(b)
	if err := u.UploadChunkContext(ctx, 0, b); !errors.Is(err, context.Canceled) || !bytes.Equal(b, original) || calls.Load() != 0 {
		t.Fatalf("error=%v calls=%d", err, calls.Load())
	}
}

func TestUploadFinishRejectsMissingChunks(t *testing.T) {
	u, _ := contextUpload(t, func(_ http.ResponseWriter, _ *http.Request) { t.Error("commit called with missing chunk") })
	if _, err := u.FinishContext(context.Background()); err == nil {
		t.Fatal("missing chunk accepted")
	}
}

func TestUploadAPIContextCancelsWhileWaitingForLock(t *testing.T) {
	m := New()
	m.apiMu.Lock()
	defer m.apiMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := m.apiRequestContext(ctx, []byte(`[{"a":"u"}]`), 0); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("API lock ignored cancellation")
	}
}
