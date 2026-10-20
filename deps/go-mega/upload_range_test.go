package mega

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestUploadRangeMatchesNativeCiphertextAndMACs(t *testing.T) {
	const size = 9*1024*1024 + 31
	plain := make([]byte, size)
	for i := range plain {
		plain[i] = byte(i*19 + 7)
	}
	var uploads []*Upload
	var ciphertexts [][]byte
	for _, grouped := range []bool{false, true} {
		ciphertext := make([]byte, size)
		u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
			offset, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/"))
			if err != nil {
				t.Error(err)
				return
			}
			body, err := io.ReadAll(r.Body)
			if err != nil || offset < 0 || offset+len(body) > len(ciphertext) {
				t.Error("invalid fixture range")
				return
			}
			copy(ciphertext[offset:], body)
			_, _ = w.Write([]byte("completion"))
		})
		u.chunks = getChunkSizes(size)
		u.chunk_macs = make([][]byte, len(u.chunks))
		var group sync.WaitGroup
		for first := 0; first < u.Chunks(); {
			count := 1
			if grouped {
				count = min(3, u.Chunks()-first)
			}
			jobFirst, jobCount := first, count
			offset, n, err := u.ChunkRangeLocation(jobFirst, jobCount)
			if err != nil {
				t.Fatal(err)
			}
			group.Add(1)
			go func() {
				defer group.Done()
				data := bytes.Clone(plain[offset : offset+int64(n)])
				if err := u.UploadRangeContext(context.Background(), jobFirst, jobCount, data); err != nil {
					t.Error(err)
				}
			}()
			first += count
		}
		group.Wait()
		uploads = append(uploads, u)
		ciphertexts = append(ciphertexts, ciphertext)
	}
	if !bytes.Equal(ciphertexts[0], ciphertexts[1]) || !reflect.DeepEqual(uploads[0].chunk_macs, uploads[1].chunk_macs) {
		t.Fatal("HTTP grouping changed native encryption or MAC boundaries")
	}
}

func TestUploadRangeFailureDoesNotAcknowledgeConstituentChunks(t *testing.T) {
	var bodies [][]byte
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, body)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	u.chunks = getChunkSizes(512 * 1024)
	u.chunk_macs = make([][]byte, len(u.chunks))
	u.EnableDiagnostics()
	if err := u.SetUploadRetryOptions(1, false); err != nil {
		t.Fatal(err)
	}
	if err := u.UploadRangeContext(context.Background(), 0, u.Chunks(), make([]byte, 512*1024)); err == nil {
		t.Fatal("failed batch accepted")
	}
	for _, mac := range u.chunk_macs {
		if len(mac) != 0 {
			t.Fatal("failed batch recorded a native MAC")
		}
	}
	if len(bodies) != 2 || !bytes.Equal(bodies[0], bodies[1]) {
		t.Fatal("batch retry did not reuse ciphertext")
	}
	if s := u.Diagnostics(); s.AcknowledgedChunks != 0 || s.Encryption.Count != int64(u.Chunks()) || s.Attempts != 2 {
		t.Fatalf("incorrect batch accounting: %+v", s)
	}
}

func TestUploadRangeValidatesBeforeMutatingPlaintext(t *testing.T) {
	u, _ := contextUpload(t, func(_ http.ResponseWriter, _ *http.Request) { t.Error("invalid range sent a request") })
	for _, tc := range []struct{ first, count, size int }{{-1, 1, 31}, {0, 0, 31}, {0, 2, 31}, {1, 1, 31}, {0, 1, 30}} {
		data := bytes.Repeat([]byte{9}, tc.size)
		original := bytes.Clone(data)
		if err := u.UploadRangeContext(context.Background(), tc.first, tc.count, data); err == nil || !bytes.Equal(data, original) {
			t.Fatal("invalid range accepted or mutated input")
		}
	}
}
