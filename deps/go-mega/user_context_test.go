package mega

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestGetUserContextCanceledBeforeRequest(t *testing.T) {
	u, _ := contextUpload(t, func(http.ResponseWriter, *http.Request) { t.Error("request after cancellation") })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := u.m.GetUserContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("unexpected canceled identity lookup: %v", err)
	}
}
