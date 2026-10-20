package mega

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

func checkpointFixture(t *testing.T) (*Upload, UploadCheckpointBinding) {
	t.Helper()
	u, _ := contextUpload(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("checkpoint validation unexpectedly sent a request")
		w.WriteHeader(http.StatusInternalServerError)
	})
	u.uploadUrl = "https://storage.example.invalid/private-capability"
	u.parenthash, u.name = "parent", "private-name"
	u.chunks = getChunkSizes(1024*1024 + 31)
	u.chunk_macs = make([][]byte, len(u.chunks))
	u.chunk_macs[0] = bytes.Repeat([]byte{7}, 16)
	return u, UploadCheckpointBinding{Account: "account", Parent: u.parenthash, Name: u.name,
		Size: 1024*1024 + 31, SHA256: sha256.Sum256([]byte("source identity"))}
}

func TestUploadCheckpointEncryptedRestoration(t *testing.T) {
	u, binding := checkpointFixture(t)
	u.ukey[0], u.ukey[4] = 123, 456
	blob, err := u.SealCheckpoint(binding, CheckpointUploading, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{u.uploadUrl, u.name, binding.Account, binding.Parent} {
		if bytes.Contains(blob, []byte(private)) {
			t.Fatal("checkpoint exposes private state")
		}
	}
	second, err := u.SealCheckpoint(binding, CheckpointUploading, "")
	if err != nil || bytes.Equal(blob, second) {
		t.Fatal("checkpoint encryption must use fresh nonces")
	}
	// A fresh authenticated client has no relation to the password-derived uh.
	m := New()
	m.k = bytes.Clone(u.m.k)
	m.uh = []byte("different password-derived login hash")
	restored, info, err := m.OpenUploadCheckpoint(blob, binding)
	if err != nil {
		t.Fatal(err)
	}
	if info.Phase != CheckpointUploading || info.AcknowledgedBytes != int64(u.chunks[0].size) ||
		info.AcknowledgedChunks != 1 || restored.ukey[0] != 123 || restored.ukey[4] != 456 ||
		restored.uploadUrl != u.uploadUrl || restored.parenthash != binding.Parent || restored.name != binding.Name {
		t.Fatal("restoration lost upload state")
	}
	u.chunk_macs[0][0]++
	if restored.chunk_macs[0][0] != 7 {
		t.Fatal("restored state aliases original MACs")
	}
	known := restored.AcknowledgedChunks()
	known[0] = false
	if !restored.AcknowledgedChunks()[0] {
		t.Fatal("acknowledgement snapshot aliases upload state")
	}
	changed := binding
	changed.SHA256[0]++
	if _, err := restored.SealCheckpoint(changed, CheckpointUploading, ""); !errors.Is(err, ErrUploadCheckpoint) {
		t.Fatal("live upload was rebound to a different source")
	}
	before, _ := restored.encryptUploadChunk(131072, make([]byte, 31))
	third, _, err := m.OpenUploadCheckpoint(blob, binding)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := third.encryptUploadChunk(131072, make([]byte, 31))
	if !bytes.Equal(before, after) {
		t.Fatal("restored native crypto changed")
	}
}

func TestUploadCheckpointRejectsTamperingAndWrongIdentity(t *testing.T) {
	u, binding := checkpointFixture(t)
	blob, err := u.SealCheckpoint(binding, CheckpointUploading, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int{0, len(checkpointMagic), len(blob) - 1} {
		tampered := bytes.Clone(blob)
		tampered[offset] ^= 1
		if _, _, err := u.m.OpenUploadCheckpoint(tampered, binding); !errors.Is(err, ErrUploadCheckpoint) {
			t.Fatal("tampered checkpoint accepted")
		}
	}
	for _, change := range []func(*UploadCheckpointBinding){
		func(b *UploadCheckpointBinding) { b.Account = "other" },
		func(b *UploadCheckpointBinding) { b.Parent = "other" },
		func(b *UploadCheckpointBinding) { b.Name = "other" },
		func(b *UploadCheckpointBinding) { b.Size++ },
		func(b *UploadCheckpointBinding) { b.SHA256[0]++ },
	} {
		wrong := binding
		change(&wrong)
		if _, _, err := u.m.OpenUploadCheckpoint(blob, wrong); !errors.Is(err, ErrUploadCheckpoint) {
			t.Fatal("wrong checkpoint binding accepted")
		}
	}
	u.m.k[0]++
	if _, _, err := u.m.OpenUploadCheckpoint(blob, binding); !errors.Is(err, ErrUploadCheckpoint) {
		t.Fatal("wrong account key accepted")
	}
	for _, short := range [][]byte{nil, blob[:10], make([]byte, MaxUploadCheckpointBytes+1)} {
		if _, _, err := u.m.OpenUploadCheckpoint(short, binding); !errors.Is(err, ErrUploadCheckpoint) {
			t.Fatal("invalid envelope length accepted")
		}
	}
}

func TestUploadCheckpointCommitPhasesNeverReplay(t *testing.T) {
	u, binding := checkpointFixture(t)
	if _, err := u.SealCheckpoint(binding, CheckpointCommitIntent, ""); !errors.Is(err, ErrUploadCheckpoint) {
		t.Fatal("incomplete upload accepted commit intent")
	}
	for i := range u.chunk_macs {
		u.chunk_macs[i] = make([]byte, 16)
	}
	u.completion_handle = []byte("handle")
	if _, err := u.SealCheckpoint(binding, CheckpointUploading, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := u.FinishContext(context.Background()); err == nil {
		t.Fatal("checkpointed upload finalized without commit intent")
	}
	for _, phase := range []UploadCheckpointPhase{CheckpointCommitIntent, CheckpointCommitted} {
		node := ""
		if phase == CheckpointCommitted {
			node = "committed-node"
			u.finishStarted = true
		}
		blob, err := u.SealCheckpoint(binding, phase, node)
		if err != nil {
			t.Fatal(err)
		}
		blocked, info, err := u.m.OpenUploadCheckpoint(blob, binding)
		if err != nil || info.Phase != phase || info.Node != node || blocked == nil {
			t.Fatal("commit guard state lost")
		}
		if _, err := blocked.FinishContext(context.Background()); err == nil {
			t.Fatal("restored commit state allowed blind finalization")
		}
		if err := blocked.UploadChunkContext(context.Background(), 0, make([]byte, u.chunks[0].size)); err == nil {
			t.Fatal("restored commit state allowed data writes")
		}
		if _, err := blocked.SealCheckpoint(binding, CheckpointUploading, ""); !errors.Is(err, ErrUploadCheckpoint) {
			t.Fatal("commit guard was reverted")
		}
		if phase == CheckpointCommitted {
			if _, err := blocked.SealCheckpoint(binding, CheckpointCommitted, "different-node"); !errors.Is(err, ErrUploadCheckpoint) {
				t.Fatal("confirmed node identity changed")
			}
		}
	}
}

func TestUploadCheckpointRejectsAuthenticatedMalformedState(t *testing.T) {
	u, _ := checkpointFixture(t)
	for _, change := range []struct {
		name string
		edit func(*uploadCheckpointState)
	}{
		{"version", func(s *uploadCheckpointState) { s.Version++ }},
		{"key", func(s *uploadCheckpointState) { s.Key = s.Key[:5] }},
		{"MAC length", func(s *uploadCheckpointState) { s.MACs[0] = []byte{1} }},
		{"chunk layout", func(s *uploadCheckpointState) { s.MACs = s.MACs[:1] }},
		{"HTTP", func(s *uploadCheckpointState) { s.URL = "http://private.invalid/token" }},
		{"URL userinfo", func(s *uploadCheckpointState) { s.URL = "https://private:secret@private.invalid/token" }},
		{"phase", func(s *uploadCheckpointState) { s.Phase = "future-phase" }},
		{"premature commit", func(s *uploadCheckpointState) { s.Phase = CheckpointCommitIntent }},
		{"unexpected node", func(s *uploadCheckpointState) { s.Node = "node" }},
		{"binding", func(s *uploadCheckpointState) { s.Binding.Parent = "other" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			u, binding := checkpointFixture(t)
			blob, err := u.SealCheckpoint(binding, CheckpointUploading, "")
			if err != nil {
				t.Fatal(err)
			}
			aead, aad, err := u.m.checkpointAEAD(binding)
			if err != nil {
				t.Fatal(err)
			}
			nonce := blob[len(checkpointMagic) : len(checkpointMagic)+aead.NonceSize()]
			raw, err := aead.Open(nil, nonce, blob[len(checkpointMagic)+aead.NonceSize():], aad)
			if err != nil {
				t.Fatal(err)
			}
			var state uploadCheckpointState
			if err := json.Unmarshal(raw, &state); err != nil {
				t.Fatal(err)
			}
			change.edit(&state)
			raw, err = json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			// A valid tag models incompatible state written by a faulty/new writer.
			bad := aead.Seal(bytes.Clone(blob[:len(checkpointMagic)+aead.NonceSize()]), nonce, raw, aad)
			if _, _, err := u.m.OpenUploadCheckpoint(bad, binding); !errors.Is(err, ErrUploadCheckpoint) {
				t.Fatal("malformed authenticated state accepted")
			}
		})
	}
	if _, err := u.SealCheckpoint(UploadCheckpointBinding{}, CheckpointUploading, ""); !errors.Is(err, ErrUploadCheckpoint) {
		t.Fatal("empty binding accepted")
	}
}
