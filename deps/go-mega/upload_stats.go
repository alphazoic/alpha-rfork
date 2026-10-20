package mega

import (
	"io"
	"net/http"
	"sync"
	"time"
)

// UploadTiming summarizes overlapping worker durations, not elapsed wall time.
type UploadTiming struct {
	Count      int64   `json:"count"`
	Seconds    float64 `json:"seconds"`
	MinSeconds float64 `json:"minSeconds"`
	MaxSeconds float64 `json:"maxSeconds"`
}

// UploadDiagnostics contains bounded aggregates without names, URLs or keys.
// PayloadBytesRead counts HTTP-body reads, including retries, not TCP/TLS bytes.
// AcknowledgedBytes does not mean the file's final commit has succeeded.
type UploadDiagnostics struct {
	Attempts                   int64        `json:"attempts"`
	Retries                    int64        `json:"retries"`
	TransportFailures          int64        `json:"transportFailures"`
	HTTPFailures               int64        `json:"httpFailures"`
	BodyFailures               int64        `json:"bodyFailures"`
	ProviderFailures           int64        `json:"providerFailures"`
	InvalidResponses           int64        `json:"invalidResponses"`
	PayloadBytesRead           int64        `json:"payloadBytesRead"`
	AcknowledgedBytes          int64        `json:"acknowledgedBytes"`
	AcknowledgedChunks         int64        `json:"acknowledgedChunks"`
	ActiveRequests             int64        `json:"activeRequests"`
	PeakRequests               int64        `json:"peakRequests"`
	MinRequestBytes            int64        `json:"minRequestBytes"`
	MaxRequestBytes            int64        `json:"maxRequestBytes"`
	FirstRequestSeconds        float64      `json:"firstRequestSeconds"`
	LastAcknowledgementSeconds float64      `json:"lastAcknowledgementSeconds"`
	Encryption                 UploadTiming `json:"encryption"`
	Pacing                     UploadTiming `json:"pacing"`
	Request                    UploadTiming `json:"request"`
	Response                   UploadTiming `json:"response"`
	Backoff                    UploadTiming `json:"backoff"`
}

type uploadStage int

const (
	uploadEncryption uploadStage = iota
	uploadPacing
	uploadRequest
	uploadResponse
	uploadBackoff
)

type uploadStats struct {
	mu      sync.Mutex
	value   UploadDiagnostics
	started time.Time
}

// EnableDiagnostics enables collection before any upload workers are started.
// It must not be called concurrently with other methods on the upload.
func (u *Upload) EnableDiagnostics() { u.stats = &uploadStats{started: time.Now()} }

// Diagnostics returns a concurrency-safe snapshot, or zeros when disabled.
func (u *Upload) Diagnostics() UploadDiagnostics {
	if u.stats == nil {
		return UploadDiagnostics{}
	}
	u.stats.mu.Lock()
	defer u.stats.mu.Unlock()
	return u.stats.value
}

func (s *uploadStats) start() time.Time {
	if s == nil {
		return time.Time{}
	}
	return time.Now()
}

func (s *uploadStats) record(stage uploadStage, start time.Time) {
	if s == nil {
		return
	}
	seconds := time.Since(start).Seconds()
	s.mu.Lock()
	defer s.mu.Unlock()
	var timing *UploadTiming
	switch stage {
	case uploadEncryption:
		timing = &s.value.Encryption
	case uploadPacing:
		timing = &s.value.Pacing
	case uploadRequest:
		timing = &s.value.Request
	case uploadResponse:
		timing = &s.value.Response
	case uploadBackoff:
		timing = &s.value.Backoff
	}
	if timing.Count == 0 || seconds < timing.MinSeconds {
		timing.MinSeconds = seconds
	}
	timing.Count++
	timing.Seconds += seconds
	timing.MaxSeconds = max(timing.MaxSeconds, seconds)
}

func (s *uploadStats) beginRequest(req *http.Request, retry int) {
	if s == nil {
		return
	}
	// Preserve NoBody identity: wrapping it changes Go's zero-length request
	// into an unknown-length/chunked request despite unchanged ContentLength.
	if req.Body != nil && req.Body != http.NoBody {
		req.Body = &uploadBodyCounter{ReadCloser: req.Body, stats: s}
	}
	if getBody := req.GetBody; getBody != nil {
		req.GetBody = func() (io.ReadCloser, error) {
			body, err := getBody()
			if err != nil {
				return nil, err
			}
			if body == http.NoBody {
				return body, nil
			}
			return &uploadBodyCounter{ReadCloser: body, stats: s}, nil
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.value.Attempts == 0 {
		s.value.MinRequestBytes = req.ContentLength
		s.value.FirstRequestSeconds = time.Since(s.started).Seconds()
	}
	s.value.MinRequestBytes = min(s.value.MinRequestBytes, req.ContentLength)
	s.value.MaxRequestBytes = max(s.value.MaxRequestBytes, req.ContentLength)
	s.value.Attempts++
	if retry > 0 {
		s.value.Retries++
	}
	s.value.ActiveRequests++
	s.value.PeakRequests = max(s.value.PeakRequests, s.value.ActiveRequests)
}

func (s *uploadStats) endRequest() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.value.ActiveRequests--
	s.mu.Unlock()
}

func (s *uploadStats) acknowledge(chunks, size int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.value.AcknowledgedBytes += int64(size)
	s.value.AcknowledgedChunks += int64(chunks)
	s.value.LastAcknowledgementSeconds = time.Since(s.started).Seconds()
	s.mu.Unlock()
}

func (s *uploadStats) failure(kind string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch kind {
	case "transport":
		s.value.TransportFailures++
	case "http":
		s.value.HTTPFailures++
	case "body":
		s.value.BodyFailures++
	case "provider":
		s.value.ProviderFailures++
	default:
		s.value.InvalidResponses++
	}
}

type uploadBodyCounter struct {
	io.ReadCloser
	stats *uploadStats
}

func (r *uploadBodyCounter) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	r.stats.mu.Lock()
	r.stats.value.PayloadBytesRead += int64(n)
	r.stats.mu.Unlock()
	return n, err
}
