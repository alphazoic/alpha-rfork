package mega

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestUploadPermanentHTTPErrorDoesNotRetry(t *testing.T) {
	calls := 0
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusForbidden)
	})
	if err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31)); err == nil || calls != 1 {
		t.Fatalf("permanent HTTP failure retried: error=%v calls=%d", err, calls)
	}
}

func TestUploadBodyErrorReplayRequiresOptIn(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(strconv.FormatBool(enabled), func(t *testing.T) {
			var bodies [][]byte
			u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				bodies = append(bodies, body)
				if len(bodies) == 1 {
					w.Header().Set("Content-Length", "100")
					_, _ = w.Write([]byte("incomplete-handle"))
					return
				}
				_, _ = w.Write([]byte("completion"))
			})
			if err := u.SetUploadRetryOptions(1, enabled); err != nil {
				t.Fatal(err)
			}
			u.EnableDiagnostics()
			err := u.UploadChunkContext(context.Background(), 0, bytes.Repeat([]byte{7}, 31))
			if enabled {
				if err != nil || len(bodies) != 2 || !bytes.Equal(bodies[0], bodies[1]) || len(u.chunk_macs[0]) != 16 {
					t.Fatalf("recovery: calls=%d error=%v", len(bodies), err)
				}
			} else if !errors.Is(err, io.ErrUnexpectedEOF) || len(bodies) != 1 || len(u.chunk_macs[0]) != 0 {
				t.Fatalf("ambiguous body replayed without opt-in: calls=%d error=%v", len(bodies), err)
			}
			if s := u.Diagnostics(); s.BodyFailures != 1 || s.ActiveRequests != 0 {
				t.Fatalf("body accounting: %+v", s)
			}
		})
	}
}

func TestUploadRetryBudgetAndPermanentProviderErrors(t *testing.T) {
	for _, tc := range []struct {
		body  string
		want  error
		calls int
	}{{"-18", ETEMPUNAVAIL, 2}, {"-17", EOVERQUOTA, 1}, {"-8", EEXPIRED, 1}} {
		t.Run(tc.body, func(t *testing.T) {
			calls := 0
			u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				calls++
				_, _ = w.Write([]byte(tc.body))
			})
			if err := u.SetUploadRetryOptions(1, false); err != nil {
				t.Fatal(err)
			}
			err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31))
			if !errors.Is(err, tc.want) || calls != tc.calls || len(u.chunk_macs[0]) != 0 {
				t.Fatalf("error=%v calls=%d", err, calls)
			}
		})
	}
}

func TestUploadRetryAfterIsCancellable(t *testing.T) {
	calls := 0
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls++
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := u.UploadChunkContext(ctx, 0, make([]byte, 31))
	if !errors.Is(err, context.DeadlineExceeded) || calls != 1 {
		t.Fatalf("error=%v calls=%d", err, calls)
	}
}

func TestUploadRetryAfterParsing(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		value string
		want  time.Duration
	}{{"2", 2 * time.Second}, {"-1", 0}, {now.Add(time.Minute).Format(http.TimeFormat), time.Minute}, {"invalid", 0}} {
		if got := uploadRetryAfter(tc.value, now); got != tc.want {
			t.Fatalf("%q: got %s want %s", tc.value, got, tc.want)
		}
	}
}

func TestUploadResponseSizeIsBounded(t *testing.T) {
	calls := 0
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls++
		_, _ = w.Write([]byte(strings.Repeat("a", maxUploadResponseBytes+1)))
	})
	err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31))
	var failure *UploadRequestError
	if !errors.As(err, &failure) || failure.Kind != "response_size" || calls != 1 || len(u.chunk_macs[0]) != 0 {
		t.Fatalf("error=%v calls=%d", err, calls)
	}
}

func TestUploadTransientProviderErrorRetriesCiphertext(t *testing.T) {
	var bodies [][]byte
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, b)
		if len(bodies) == 1 {
			_, _ = w.Write([]byte("-3"))
			return
		}
		_, _ = w.Write([]byte("completion"))
	})
	if err := u.UploadChunkContext(context.Background(), 0, bytes.Repeat([]byte{9}, 31)); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 2 || !bytes.Equal(bodies[0], bodies[1]) {
		t.Fatal("provider retry changed ciphertext")
	}
}

func TestUploadTransportErrorDoesNotExposeURL(t *testing.T) {
	u, server := contextUpload(t, func(_ http.ResponseWriter, _ *http.Request) {})
	server.Close()
	err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31))
	if err == nil || strings.Contains(err.Error(), u.uploadUrl) {
		t.Fatalf("transport error exposed private upload URL: %v", err)
	}
}
