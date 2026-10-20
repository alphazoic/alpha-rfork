package mega

import (
	"bytes"
	"crypto/sha256"
	"testing"
)

func TestUploadRestartProbeState(t *testing.T) {
	plain := restartProbePlaintext()
	u, _ := contextUpload(t, nil)
	u.uploadUrl = "https://example.invalid/private"
	u.parenthash, u.name = "parent", "probe.bin"
	u.chunks = getChunkSizes(int64(len(plain)))
	u.chunk_macs = make([][]byte, len(u.chunks))
	// The probe must retain original key material and independent MAC slices;
	// finalization and a later request must not change its saved state.
	u.chunk_macs[0] = bytes.Repeat([]byte{7}, 16)
	saved := snapshotRestartProbe(u, "account", "case", plain)
	u.ukey[0]++
	u.chunk_macs[0][0]++
	restored, err := restoreRestartProbe(saved, u.m, "account", plain)
	if err != nil {
		t.Fatal(err)
	}
	if restored.ukey[0] == u.ukey[0] || restored.chunk_macs[0][0] != 7 {
		t.Fatal("probe snapshot aliases live crypto state")
	}
	restored.chunk_macs[0][0]++
	if saved.MACs[0][0] != 7 {
		t.Fatal("restored MACs alias saved state")
	}
	for _, mutate := range []struct {
		name string
		edit func(*restartProbeState)
	}{
		{"version", func(s *restartProbeState) { s.Version++ }},
		{"key", func(s *restartProbeState) { s.Key = s.Key[:5] }},
		{"MAC", func(s *restartProbeState) { s.MACs[0] = []byte{1} }},
		{"layout", func(s *restartProbeState) { s.MACs = s.MACs[:1] }},
		{"size", func(s *restartProbeState) { s.Size++ }},
		{"source", func(s *restartProbeState) { s.SHA256 = sha256.Sum256([]byte("changed")) }},
		{"account", func(s *restartProbeState) { s.Account = "other" }},
		{"URL", func(s *restartProbeState) { s.URL = "http://example.invalid/private" }},
		{"URL credentials", func(s *restartProbeState) { s.URL = "https://user:password@example.invalid/private" }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			state := snapshotRestartProbe(restored, "account", "case", plain)
			mutate.edit(&state)
			if _, err := restoreRestartProbe(state, u.m, "account", plain); err == nil {
				t.Fatal("invalid probe state accepted")
			}
		})
	}
}
