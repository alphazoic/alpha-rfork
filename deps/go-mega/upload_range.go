package mega

import (
	"context"
	"crypto/cipher"
	"errors"
)

// ChunkRangeLocation returns the offset and total size of complete contiguous
// native chunks. It rejects invalid IDs, counts and noncontiguous boundaries.
func (u *Upload) ChunkRangeLocation(first, count int) (position int64, size int, err error) {
	if first < 0 || first >= len(u.chunks) || count < 1 || count > len(u.chunks)-first {
		return 0, 0, EARGS
	}
	position = u.chunks[first].position
	for _, chunk := range u.chunks[first : first+count] {
		if chunk.size < 0 || chunk.size > 1024*1024 || chunk.position != position+int64(size) || chunk.size > int(^uint(0)>>1)-size {
			return 0, 0, EARGS
		}
		size += chunk.size
	}
	return position, size, nil
}

// UploadRangeContext encrypts complete contiguous native chunks and sends them
// in one request. The caller owns plaintext and supplies each chunk only once.
// Native MAC boundaries remain unchanged; retries reuse the encrypted buffer.
// This is experimental until live server acceptance has been validated.
func (u *Upload) UploadRangeContext(ctx context.Context, first, count int, plaintext []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	u.mutex.Lock()
	finishing := u.finishStarted
	u.mutex.Unlock()
	if finishing {
		return errors.New("upload finalization already started")
	}
	position, size, err := u.ChunkRangeLocation(first, count)
	if err != nil {
		return err
	}
	if len(plaintext) != size {
		return errors.New("upload range is wrong size")
	}
	macs := make([][]byte, count)
	start := 0
	for i, chunk := range u.chunks[first : first+count] {
		if err := ctx.Err(); err != nil {
			return err
		}
		macs[i], err = u.encryptUploadChunk(chunk.position, plaintext[start:start+chunk.size])
		if err != nil {
			return err
		}
		start += chunk.size
	}
	response, err := u.sendUploadRequest(ctx, position, plaintext)
	if err != nil {
		return err
	}
	u.mutex.Lock()
	if len(response) > 0 {
		u.completion_handle = response
	}
	copy(u.chunk_macs[first:first+count], macs)
	u.mutex.Unlock()
	u.stats.acknowledge(count, len(plaintext))
	return nil
}

func (u *Upload) encryptUploadChunk(position int64, plaintext []byte) ([]byte, error) {
	started := u.stats.start()
	defer func() { u.stats.record(uploadEncryption, started) }()
	ctrIV, err := bytes_to_a32(u.kiv)
	if err != nil {
		return nil, err
	}
	ctrIV[2] = uint32(uint64(position) / 0x1000000000)
	ctrIV[3] = uint32(position / 0x10)
	iv, err := a32_to_bytes(ctrIV)
	if err != nil {
		return nil, err
	}
	enc := cipher.NewCBCEncrypter(u.aes_block, u.iv)
	mac := make([]byte, 16)
	padded := paddnull(plaintext, 16)
	for i := 0; i < len(padded); i += 16 {
		copy(mac, padded[i:i+16])
		enc.CryptBlocks(mac, mac)
	}
	cipher.NewCTR(u.aes_block, iv).XORKeyStream(plaintext, plaintext)
	return mac, nil
}
