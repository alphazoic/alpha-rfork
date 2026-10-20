package mega

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestUploadDiagnosticsRetryAccountingAndPrivacy(t *testing.T) {
	calls := 0
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("private-completion-token"))
	})
	u.name = "private-filename"
	u.EnableDiagnostics()
	if err := u.UploadChunkContext(context.Background(), 0, bytes.Repeat([]byte{7}, 31)); err != nil {
		t.Fatal(err)
	}
	s := u.Diagnostics()
	if s.Attempts != 2 || s.Retries != 1 || s.PayloadBytesRead != 62 || s.AcknowledgedBytes != 31 || s.AcknowledgedChunks != 1 {
		t.Fatalf("incorrect byte/retry accounting: %+v", s)
	}
	if s.Encryption.Count != 1 || s.Request.Count != 2 || s.Response.Count != 2 || s.Backoff.Count != 1 || s.PeakRequests != 1 || s.ActiveRequests != 0 {
		t.Fatalf("incorrect stage accounting: %+v", s)
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{u.name, u.uploadUrl, "private-completion-token"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("diagnostics contain private upload state")
		}
	}
}

func TestUploadDiagnosticsDisabled(t *testing.T) {
	u, _ := contextUpload(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("completion")) })
	if err := u.UploadChunkContext(context.Background(), 0, make([]byte, 31)); err != nil {
		t.Fatal(err)
	}
	if s := u.Diagnostics(); s != (UploadDiagnostics{}) {
		t.Fatalf("disabled diagnostics collected data: %+v", s)
	}
}

func TestUploadDiagnosticsPreservesEmptyRequestFraming(t *testing.T) {
	u, _ := contextUpload(t, func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte("completion"))
	})
	u.chunks = []chunkSize{{position: 0, size: 0}}
	u.EnableDiagnostics()
	if err := u.UploadChunkContext(context.Background(), 0, []byte{}); err != nil {
		t.Fatalf("diagnostics changed empty request framing: %v", err)
	}
	if s := u.Diagnostics(); s.PayloadBytesRead != 0 || s.Attempts != 1 || s.AcknowledgedChunks != 1 {
		t.Fatalf("empty upload diagnostics: %+v", s)
	}
}
