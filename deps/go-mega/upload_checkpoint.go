package mega

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/url"
)

// MaxUploadCheckpointBytes bounds the encrypted envelope and decode allocation.
const MaxUploadCheckpointBytes = 64 << 20

const checkpointMagic = "rfork-mega-checkpoint-v1\x00"

// ErrUploadCheckpoint reports invalid, unauthenticated or incompatible state.
// Its message deliberately excludes private state and decryption details.
var ErrUploadCheckpoint = errors.New("invalid or incompatible MEGA upload checkpoint")

// ErrUploadCheckpointSource means saved acknowledgement MACs do not authenticate
// the actual source bytes. Such ranges must never be skipped or finalized.
var ErrUploadCheckpointSource = errors.New("MEGA checkpoint acknowledged content does not match source")

// UploadCheckpointPhase records irreversible progress toward file creation.
type UploadCheckpointPhase string

const (
	// CheckpointUploading permits restoration of the original data session.
	CheckpointUploading UploadCheckpointPhase = "uploading"
	// CheckpointCommitIntent forbids automatic finalization after restoration.
	CheckpointCommitIntent UploadCheckpointPhase = "commit-intent"
	// CheckpointCommitted retains a confirmed node identity without replaying it.
	CheckpointCommitted UploadCheckpointPhase = "committed"
)

// UploadCheckpointBinding identifies the verified source and exact destination.
// Account is the stable user handle from GetUser, not the password-derived uh.
type UploadCheckpointBinding struct {
	// Account is the authenticated account's stable user handle.
	Account string
	// Parent is the exact destination parent node handle.
	Parent string
	// Name is the encoded destination leaf name.
	Name string
	// Size is the verified regular source file's byte size (at most 1 TiB).
	Size int64
	// SHA256 is the verified complete source content hash.
	SHA256 [32]byte
}

// UploadCheckpointInfo contains restoration counters and finalization guards.
type UploadCheckpointInfo struct {
	// Phase determines whether further data/commit operations are allowed.
	Phase UploadCheckpointPhase
	// Node is the confirmed created node handle, only in the committed phase.
	Node string
	// AcknowledgedBytes counts native payload bytes restored from the checkpoint.
	AcknowledgedBytes int64
	// AcknowledgedChunks counts complete native MACs restored from the checkpoint.
	AcknowledgedChunks int
}

type uploadCheckpointState struct {
	Version int
	Binding UploadCheckpointBinding
	URL     string
	Key     []uint32
	MACs    [][]byte
	Handle  []byte
	Phase   UploadCheckpointPhase
	Node    string
}

func checkpointChunks(size int64) []chunkSize {
	chunks := getChunkSizes(size)
	if len(chunks) == 0 {
		chunks = []chunkSize{{position: 0, size: 0}}
	}
	return chunks
}

func validCheckpointBinding(b UploadCheckpointBinding) bool {
	return b.Size >= 0 && b.Size <= 1<<40 && len(b.Account) > 0 && len(b.Account) <= 256 &&
		len(b.Parent) > 0 && len(b.Parent) <= 256 && len(b.Name) > 0 && len(b.Name) <= 1024
}

func (s *uploadCheckpointState) validate() error {
	if s.Version != 1 || !validCheckpointBinding(s.Binding) || len(s.URL) > 8192 || len(s.Key) != 6 ||
		len(s.Handle) > maxUploadResponseBytes || len(s.Node) > 256 {
		return ErrUploadCheckpoint
	}
	endpoint, err := url.Parse(s.URL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return ErrUploadCheckpoint
	}
	chunks := checkpointChunks(s.Binding.Size)
	if len(chunks) != len(s.MACs) {
		return ErrUploadCheckpoint
	}
	complete := true
	for _, mac := range s.MACs {
		if len(mac) != 0 && len(mac) != aes.BlockSize {
			return ErrUploadCheckpoint
		}
		complete = complete && len(mac) == aes.BlockSize
	}
	if complete && len(s.Handle) == 0 {
		return ErrUploadCheckpoint
	}
	switch s.Phase {
	case CheckpointUploading:
		if s.Node != "" {
			return ErrUploadCheckpoint
		}
	case CheckpointCommitIntent:
		if !complete || len(s.Handle) == 0 || s.Node != "" {
			return ErrUploadCheckpoint
		}
	case CheckpointCommitted:
		if !complete || len(s.Handle) == 0 || s.Node == "" {
			return ErrUploadCheckpoint
		}
	default:
		return ErrUploadCheckpoint
	}
	return nil
}

func (m *Mega) checkpointAEAD(binding UploadCheckpointBinding) (cipher.AEAD, []byte, error) {
	if len(m.k) != aes.BlockSize || !validCheckpointBinding(binding) {
		return nil, nil, ErrUploadCheckpoint
	}
	// The stable account master key survives fresh authentication. Domain
	// separation keeps checkpoint keys independent of MEGA's protocol ciphers.
	derive := hmac.New(sha256.New, m.k)
	_, _ = derive.Write([]byte(checkpointMagic + binding.Account))
	block, err := aes.NewCipher(derive.Sum(nil))
	if err != nil {
		return nil, nil, ErrUploadCheckpoint
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, ErrUploadCheckpoint
	}
	encoded, err := json.Marshal(binding)
	if err != nil {
		return nil, nil, ErrUploadCheckpoint
	}
	return aead, append([]byte(checkpointMagic), encoded...), nil
}

// SealCheckpoint encrypts an atomic snapshot of original crypto/MAC/session state.
// It is safe while data workers run. The caller must join workers before commit
// intent, durably save that envelope before FinishContext, and serialize writes.
// A committed snapshot requires finalization to have started and a confirmed node.
// Storage, source verification and cross-process ownership remain caller duties.
func (u *Upload) SealCheckpoint(binding UploadCheckpointBinding, phase UploadCheckpointPhase, node string) ([]byte, error) {
	if !validCheckpointBinding(binding) || binding.Parent != u.parenthash || binding.Name != u.name {
		return nil, ErrUploadCheckpoint
	}
	aead, aad, err := u.m.checkpointAEAD(binding)
	if err != nil {
		return nil, err
	}
	u.mutex.Lock()
	defer u.mutex.Unlock()
	if u.finishStarted && phase != CheckpointCommitted ||
		phase == CheckpointCommitted && !u.finishStarted ||
		u.checkpointPhase == CheckpointCommitted && phase != CheckpointCommitted ||
		u.checkpointPhase == CheckpointCommitIntent && phase == CheckpointUploading ||
		u.checkpointBinding != nil && *u.checkpointBinding != binding ||
		u.checkpointPhase == CheckpointCommitted && u.checkpointNode != node {
		return nil, ErrUploadCheckpoint
	}
	chunks := checkpointChunks(binding.Size)
	if len(chunks) != len(u.chunks) {
		return nil, ErrUploadCheckpoint
	}
	for i, chunk := range chunks {
		if chunk != u.chunks[i] {
			return nil, ErrUploadCheckpoint
		}
	}
	state := uploadCheckpointState{Version: 1, Binding: binding, URL: u.uploadUrl,
		Key: u.ukey, MACs: u.chunk_macs, Handle: u.completion_handle, Phase: phase, Node: node}
	if err := state.validate(); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(state)
	if err != nil || len(raw) > MaxUploadCheckpointBytes-len(checkpointMagic)-aead.NonceSize()-aead.Overhead() {
		return nil, ErrUploadCheckpoint
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, errors.New("MEGA checkpoint entropy unavailable")
	}
	prefix := append([]byte(checkpointMagic), nonce...)
	blob := aead.Seal(prefix, nonce, raw, aad)
	u.checkpointPhase = phase
	u.checkpointBinding = &binding
	u.checkpointNode = node
	return blob, nil
}

// OpenUploadCheckpoint authenticates state against a freshly verified binding.
// It sends no requests and never creates a replacement upload session. The caller
// must verify the complete source and every saved range's MAC using
// VerifyAcknowledgedChunk, and resolve the exact parent after fresh login.
// Restored commit-intent/committed sessions reject data writes and finalization;
// an uncertain commit must never be replayed on the basis of filename/size alone.
func (m *Mega) OpenUploadCheckpoint(blob []byte, binding UploadCheckpointBinding) (*Upload, UploadCheckpointInfo, error) {
	info := UploadCheckpointInfo{}
	if len(blob) > MaxUploadCheckpointBytes || !bytes.HasPrefix(blob, []byte(checkpointMagic)) {
		return nil, info, ErrUploadCheckpoint
	}
	aead, aad, err := m.checkpointAEAD(binding)
	if err != nil || len(blob) < len(checkpointMagic)+aead.NonceSize()+aead.Overhead() {
		return nil, info, ErrUploadCheckpoint
	}
	nonce := blob[len(checkpointMagic) : len(checkpointMagic)+aead.NonceSize()]
	raw, err := aead.Open(nil, nonce, blob[len(checkpointMagic)+aead.NonceSize():], aad)
	if err != nil {
		return nil, info, ErrUploadCheckpoint
	}
	var state uploadCheckpointState
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&state) != nil || decoder.Decode(new(any)) != io.EOF || state.Binding != binding || state.validate() != nil {
		return nil, info, ErrUploadCheckpoint
	}
	key, err := a32_to_bytes(state.Key[:4])
	if err != nil {
		return nil, info, ErrUploadCheckpoint
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, info, ErrUploadCheckpoint
	}
	kiv, _ := a32_to_bytes([]uint32{state.Key[4], state.Key[5], 0, 0})
	iv, _ := a32_to_bytes([]uint32{state.Key[4], state.Key[5], state.Key[4], state.Key[5]})
	u := &Upload{m: m, parenthash: binding.Parent, name: binding.Name, uploadUrl: state.URL,
		aes_block: block, iv: iv, kiv: kiv, mac_enc: cipher.NewCBCEncrypter(block, zero_iv),
		kbytes: key, ukey: state.Key, chunks: checkpointChunks(binding.Size), chunk_macs: state.MACs,
		completion_handle: state.Handle, finishStarted: state.Phase != CheckpointUploading, checkpointPhase: state.Phase,
		checkpointBinding: &binding, checkpointNode: state.Node}
	info.Phase, info.Node = state.Phase, state.Node
	for i, mac := range state.MACs {
		if len(mac) == aes.BlockSize {
			info.AcknowledgedChunks++
			info.AcknowledgedBytes += int64(u.chunks[i].size)
		}
	}
	return u, info, nil
}

// AcknowledgedChunks returns an independent bitmap of complete native MACs.
func (u *Upload) AcknowledgedChunks() []bool {
	u.mutex.Lock()
	defer u.mutex.Unlock()
	known := make([]bool, len(u.chunk_macs))
	for i, mac := range u.chunk_macs {
		known[i] = len(mac) == aes.BlockSize
	}
	return known
}

// VerifyAcknowledgedChunk authenticates actual source bytes against a saved MAC
// without modifying plaintext. Call it for every skipped native range during the
// actual source read, in addition to full-file hashing. A preflight hash alone
// cannot establish that bytes uploaded before a crash came from that version.
func (u *Upload) VerifyAcknowledgedChunk(id int, plaintext []byte) error {
	u.mutex.Lock()
	if id < 0 || id >= len(u.chunks) || len(plaintext) != u.chunks[id].size ||
		len(u.chunk_macs[id]) != aes.BlockSize {
		u.mutex.Unlock()
		return ErrUploadCheckpoint
	}
	want := bytes.Clone(u.chunk_macs[id])
	u.mutex.Unlock()
	if !hmac.Equal(want, u.uploadChunkMAC(plaintext)) {
		return ErrUploadCheckpointSource
	}
	return nil
}
