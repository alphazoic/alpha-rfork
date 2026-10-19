package mega

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	rand "math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxUploadResponseBytes = 4096

// UploadRequestError classifies a failed data request without printing its URL.
// Unwrap preserves the underlying error for errors.Is and errors.As.
type UploadRequestError struct {
	Kind       string
	StatusCode int
	Retryable  bool
	cause      error
	retryAfter time.Duration
}

func (e *UploadRequestError) Error() string {
	if e.Kind == "provider" {
		return fmt.Sprintf("MEGA upload request failed (provider): %v", e.cause)
	}
	if e.Kind == "transport" || e.Kind == "body" {
		return fmt.Sprintf("MEGA upload network request failed (%s)", e.Kind)
	}
	if e.StatusCode == 509 {
		return "MEGA upload transfer quota exceeded (HTTP 509)"
	}
	if e.StatusCode != 0 {
		return fmt.Sprintf("MEGA upload request failed (%s, HTTP %d)", e.Kind, e.StatusCode)
	}
	return fmt.Sprintf("MEGA upload request failed (%s)", e.Kind)
}

// Unwrap returns the underlying failure for programmatic inspection.
func (e *UploadRequestError) Unwrap() error { return e.cause }

// SetUploadRetryOptions configures per-file data retries before workers start.
// retries is the number of additional attempts. Body-error replay is opt-in
// because a lost terminal response can contain the upload completion handle.
func (u *Upload) SetUploadRetryOptions(retries int, retryBodyErrors bool) error {
	if retries < 0 {
		return errors.New("upload retries must be nonnegative")
	}
	u.uploadRetries = &retries
	u.retryBodyErrors = retryBodyErrors
	return nil
}

func (u *Upload) sendUploadRequest(ctx context.Context, offset int64, ciphertext []byte) ([]byte, error) {
	retries := u.m.retries
	if u.uploadRetries != nil {
		retries = *u.uploadRetries
	}
	delay := minSleepTime
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		body, err := u.uploadRequestAttempt(ctx, offset, ciphertext, attempt)
		if err == nil {
			return body, nil
		}
		var failure *UploadRequestError
		if !errors.As(err, &failure) {
			return nil, err
		}
		u.stats.failure(failure.Kind)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !failure.Retryable || attempt >= retries {
			return nil, err
		}
		// Jitter applies to local backoff, never shortens server Retry-After.
		wait := max(delay/2+time.Duration(rand.Int64N(int64(delay/2)+1)), failure.retryAfter)
		started := u.stats.start()
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			u.stats.record(uploadBackoff, started)
			return nil, ctx.Err()
		case <-timer.C:
		}
		u.stats.record(uploadBackoff, started)
		delay = min(delay*2, maxSleepTime)
	}
}

func (u *Upload) uploadRequestAttempt(ctx context.Context, offset int64, ciphertext []byte, attempt int) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s/%d", u.uploadUrl, offset), bytes.NewBuffer(ciphertext))
	if err != nil {
		return nil, &UploadRequestError{Kind: "request", cause: err}
	}
	u.stats.beginRequest(req, attempt)
	defer u.stats.endRequest()
	started := u.stats.start()
	rsp, err := u.m.client.Do(req)
	u.stats.record(uploadRequest, started)
	if err != nil {
		return nil, &UploadRequestError{Kind: "transport", Retryable: true, cause: err}
	}
	started = u.stats.start()
	body, readErr := io.ReadAll(io.LimitReader(rsp.Body, maxUploadResponseBytes+1))
	closeErr := rsp.Body.Close()
	u.stats.record(uploadResponse, started)
	if rsp.StatusCode != http.StatusOK {
		retryable := rsp.StatusCode == 408 || rsp.StatusCode == 429 || rsp.StatusCode == 500 || rsp.StatusCode == 502 || rsp.StatusCode == 503 || rsp.StatusCode == 504
		return nil, &UploadRequestError{Kind: "http", StatusCode: rsp.StatusCode, Retryable: retryable, retryAfter: uploadRetryAfter(rsp.Header.Get("Retry-After"), time.Now())}
	}
	if readErr != nil || closeErr != nil {
		return nil, &UploadRequestError{Kind: "body", Retryable: u.retryBodyErrors, cause: errors.Join(readErr, closeErr)}
	}
	if len(body) > maxUploadResponseBytes {
		return nil, &UploadRequestError{Kind: "response_size"}
	}
	body = bytes.TrimSpace(body)
	if len(body) > 0 && body[0] == '-' {
		var code ErrorMsg
		// Opaque URL-safe completion handles can also begin with '-'.
		if json.Unmarshal(body, &code) == nil && code < 0 {
			err = parseError(code)
			retryable := errors.Is(err, EAGAIN) || errors.Is(err, ERATELIMIT) || errors.Is(err, ETEMPUNAVAIL) || errors.Is(err, EINTERNAL)
			return nil, &UploadRequestError{Kind: "provider", Retryable: retryable, cause: err}
		}
	}
	return body, nil
}

func uploadRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseInt(value, 10, 32); err == nil {
		return max(0, time.Duration(seconds)*time.Second)
	}
	if date, err := http.ParseTime(value); err == nil {
		return max(0, date.Sub(now))
	}
	return 0
}
