package accounting

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/stretchr/testify/require"
	"golang.org/x/time/rate"
)

func TestAccountReadContextCancelsBandwidthWait(t *testing.T) {
	for _, global := range []bool{false, true} {
		t.Run(map[bool]string{false: "per-file", true: "global"}[global], func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stats := NewStats(ctx)
			acc := newAccountSizeName(ctx, stats, io.NopCloser(strings.NewReader("")), 10, "context-test")
			defer acc.Done()
			limiter := rate.NewLimiter(1, 10)
			require.True(t, limiter.AllowN(time.Now(), 10))
			if global {
				TokenBucket.mu.Lock()
				old := TokenBucket.curr
				TokenBucket.curr = buckets{TokenBucketSlotAccounting: limiter}
				TokenBucket.mu.Unlock()
				defer func() { TokenBucket.mu.Lock(); TokenBucket.curr = old; TokenBucket.mu.Unlock() }()
			} else {
				acc.tokenBucket[TokenBucketSlotAccounting] = limiter
			}
			done := make(chan error, 1)
			go func() { done <- acc.AccountReadContext(ctx, 10) }()
			time.Sleep(20 * time.Millisecond)
			cancel()
			select {
			case err := <-done:
				require.ErrorIs(t, err, context.Canceled)
			case <-time.After(2 * time.Second):
				t.Fatal("bandwidth wait ignored cancellation")
			}
			require.Equal(t, int64(10), stats.GetBytes())
		})
	}
}

func TestAccountReadContextHonorsTransferLimit(t *testing.T) {
	ctx, ci := fs.AddConfig(context.Background())
	ci.MaxTransfer = 4
	ci.CutoffMode = fs.CutoffModeHard
	stats := NewStats(ctx)
	acc := newAccountSizeName(ctx, stats, io.NopCloser(strings.NewReader("")), 10, "limited")
	defer acc.Done()
	require.ErrorIs(t, acc.AccountReadContext(ctx, 10), ErrorMaxTransferLimitReachedFatal)
	require.Equal(t, int64(4), stats.GetBytes())
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	require.ErrorIs(t, acc.AccountReadContext(canceled, 1), context.Canceled)
	require.Equal(t, int64(4), stats.GetBytes())
}

func TestAccountReadContextAcceptsLargerThanBurst(t *testing.T) {
	ctx := context.Background()
	stats := NewStats(ctx)
	acc := newAccountSizeName(ctx, stats, io.NopCloser(strings.NewReader("")), 32, "large-request")
	defer acc.Done()
	acc.tokenBucket[TokenBucketSlotAccounting] = rate.NewLimiter(1e8, 4)
	require.NoError(t, acc.AccountReadContext(ctx, 32))
	require.Equal(t, int64(32), stats.GetBytes())
}
